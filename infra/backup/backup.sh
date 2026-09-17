#!/usr/bin/env bash
#
# Резервное копирование ФАЙЛОВ проекта (ТЗ п. 4, docs/10-nfr-security.md §5).
#
# ВАЖНО — ИЗМЕНЕНИЕ ПО ОТВЕТУ A1:
#   PostgreSQL теперь ВНЕШНИЙ — существующий сервер предприятия, общий с другими
#   системами. Его резервное копирование и PITR выполняет АДМИНИСТРАТОР БД,
#   а не этот скрипт. Регламент нужно согласовать письменно:
#   infra/db/README.md §5.
#
#   Этот скрипт отвечает только за то, что принадлежит проекту:
#     • фотографии изделий;
#     • записи разговоров;
#     • сформированные PDF (квитанции, акты);
#     • конфигурацию (зашифрованно).
#
# Использование:
#   ./backup.sh files     — выгрузить файлы проекта (ежедневно)
#   ./backup.sh config    — выгрузить конфигурацию без .env (еженедельно)
#   ./backup.sh verify    — проверить свежесть последней копии
#   ./backup.sh list      — показать существующие копии
#
# Переменные окружения (или .env):
#   BACKUP_DIR, BACKUP_REMOTE, BACKUP_ENCRYPTION_KEY
#   S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BACKUP_BUCKET

set -Eeuo pipefail

# --- Конфигурация -----------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/var/backups/repair}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"                   # напр. user@backup-host:/backups/repair
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"   # если задан — копии шифруются
RETENTION_DAYS="${RETENTION_DAYS:-90}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/docker-compose.prod.yml}"
S3_BACKUP_BUCKET="${S3_BACKUP_BUCKET:-repair-backups}"
MINIO_ALIAS="${MINIO_ALIAS:-repair-local}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
HOSTNAME_SHORT="$(hostname -s)"
LOG_PREFIX="[backup $(date '+%Y-%m-%d %H:%M:%S')]"

log()  { echo "${LOG_PREFIX} $*"; }
fail() { echo "${LOG_PREFIX} ОШИБКА: $*" >&2; exit 1; }

# --- Алерты ------------------------------------------------------------------

notify_failure() {
  local message="$1"
  log "АЛЕРТ: ${message}"
  # Настроить под свою систему алертов, например:
  #   curl -s -X POST "$ALERT_WEBHOOK" -d "{\"text\":\"${message}\"}" || true
}

# --- Шифрование --------------------------------------------------------------

encrypt_if_needed() {
  local input="$1"
  if [[ -z "${BACKUP_ENCRYPTION_KEY}" ]]; then
    echo "${input}"
    return
  fi
  if ! command -v age >/dev/null 2>&1; then
    # Молча оставлять копию незашифрованной нельзя: это персональные данные
    # и записи разговоров (152-ФЗ).
    fail "BACKUP_ENCRYPTION_KEY задан, но утилита age не установлена — копия не зашифрована"
  fi
  local output="${input}.age"
  age --encrypt --passphrase --output "${output}" "${input}" \
    <<<"${BACKUP_ENCRYPTION_KEY}" || fail "не удалось зашифровать ${input}"
  rm -f "${input}"
  echo "${output}"
}

# --- Копирование -------------------------------------------------------------

copy_remote() {
  local file="$1"
  if [[ -z "${BACKUP_REMOTE}" ]]; then
    log "BACKUP_REMOTE не задан — внешняя копия пропущена"
    log "ВНИМАНИЕ: правило 3-2-1 не выполняется (нет копии вне сервера)"
    return 0
  fi
  log "Копирую на внешний носитель: ${BACKUP_REMOTE}"
  scp -q "${file}" "${BACKUP_REMOTE}/" \
    || { notify_failure "Не удалось скопировать копию на ${BACKUP_REMOTE}"; return 1; }
}

# --- Выгрузка файлов MinIO ---------------------------------------------------

do_files() {
  mkdir -p "${BACKUP_DIR}/files"
  local archive="${BACKUP_DIR}/files/repair-files-${HOSTNAME_SHORT}-${TIMESTAMP}.tar.gz"

  log "Выгружаю файлы проекта из MinIO"

  # MinIO хранит данные в томе docker. Копируем через контейнер, чтобы не
  # зависеть от пути тома на хосте.
  if docker compose -f "${COMPOSE_FILE}" ps --status running --services 2>/dev/null | grep -qx 'minio'; then
    docker compose -f "${COMPOSE_FILE}" exec -T minio \
      tar -czf - -C /data . > "${archive}" \
      || { notify_failure "Не удалось выгрузить файлы из MinIO"; fail "выгрузка не удалась"; }
  else
    # MinIO может быть внешним — тогда выгружаем через mc.
    if command -v mc >/dev/null 2>&1 && [[ -n "${S3_ENDPOINT:-}" ]]; then
      log "MinIO в compose не найден, выгружаю через mc с ${S3_ENDPOINT}"
      mc alias set "${MINIO_ALIAS}" "${S3_ENDPOINT}" \
        "${S3_ACCESS_KEY:?задайте S3_ACCESS_KEY}" "${S3_SECRET_KEY:?задайте S3_SECRET_KEY}" >/dev/null
      local tmp_dir
      tmp_dir="$(mktemp -d)"
      for bucket in repair-photos repair-calls repair-docs; do
        mc mirror --quiet "${MINIO_ALIAS}/${bucket}" "${tmp_dir}/${bucket}" 2>/dev/null || true
      done
      tar -czf "${archive}" -C "${tmp_dir}" . || fail "не удалось создать архив"
      rm -rf "${tmp_dir}"
    else
      fail "MinIO недоступен: сервис не запущен, а mc/S3_ENDPOINT не настроены"
    fi
  fi

  [[ -s "${archive}" ]] || fail "архив пуст — выгрузка не выполнена"

  local size
  size="$(du -h "${archive}" | cut -f1)"
  log "Архив создан: ${archive} (${size})"

  # Проверка читаемости архива — иначе о повреждении узнаем при восстановлении.
  tar -tzf "${archive}" >/dev/null 2>&1 \
    || { notify_failure "Архив ${archive} повреждён"; fail "повреждённый архив"; }
  log "Целостность архива подтверждена"

  local final_file
  final_file="$(encrypt_if_needed "${archive}")"
  copy_remote "${final_file}" || true

  # Третья копия — в отдельный бакет MinIO (вне контейнера).
  if command -v mc >/dev/null 2>&1 && [[ -n "${S3_ENDPOINT:-}" ]]; then
    log "Загружаю копию в бакет ${S3_BACKUP_BUCKET}"
    mc alias set "${MINIO_ALIAS}" "${S3_ENDPOINT}" "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}" >/dev/null 2>&1 || true
    mc cp --quiet "${final_file}" "${MINIO_ALIAS}/${S3_BACKUP_BUCKET}/files/" \
      || notify_failure "Не удалось загрузить копию в ${S3_BACKUP_BUCKET}"
  fi

  echo "${final_file}"
}

# --- Выгрузка конфигурации ---------------------------------------------------

do_config() {
  mkdir -p "${BACKUP_DIR}/config"
  local archive="${BACKUP_DIR}/config/repair-config-${HOSTNAME_SHORT}-${TIMESTAMP}.tar.gz"

  log "Выгружаю конфигурацию проекта"

  # .env НЕ включается в незашифрованном виде: он содержит пароли и секреты.
  # Если задан ключ шифрования, .env попадает в архив и шифруется вместе с ним.
  local items=(infra docs package.json package-lock.json tsconfig.base.json)
  local existing=()
  for item in "${items[@]}"; do
    [[ -e "${item}" ]] && existing+=("${item}")
  done
  (( ${#existing[@]} > 0 )) || fail "не найдено файлов конфигурации"

  local tmp_list
  tmp_list="$(mktemp)"
  printf '%s\n' "${existing[@]}" > "${tmp_list}"

  if [[ -n "${BACKUP_ENCRYPTION_KEY}" && -f .env ]]; then
    log "Ключ шифрования задан — .env включается в архив"
    printf '%s\n' ".env" >> "${tmp_list}"
  else
    log "ПРЕДУПРЕЖДЕНИЕ: .env не включён (нет ключа шифрования)."
    log "  Сохраните секреты отдельно в защищённом хранилище."
  fi

  tar -czf "${archive}" -T "${tmp_list}" 2>/dev/null || fail "не удалось создать архив конфигурации"
  rm -f "${tmp_list}"

  local final_file
  final_file="$(encrypt_if_needed "${archive}")"
  copy_remote "${final_file}" || true
  echo "${final_file}"
}

# --- Проверка ----------------------------------------------------------------

do_verify() {
  local latest
  latest="$(find "${BACKUP_DIR}" -name 'repair-*' -type f \( -name '*.tar.gz' -o -name '*.age' \) \
    -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1 || true)"

  [[ -n "${latest}" ]] || fail "копии не найдены в ${BACKUP_DIR}"
  log "Проверяю: ${latest}"

  # Зашифрованную копию проверить без ключа нельзя — проверяем только наличие.
  if [[ "${latest}" == *.age ]]; then
    log "Копия зашифрована (age). Целостность проверяется при восстановлении с ключом."
    log "Обязательно выполните учебное восстановление: infra/backup/restore-drill.sh"
  else
    tar -tzf "${latest}" >/dev/null 2>&1 || fail "копия ${latest} повреждена или нечитаема"
    log "Целостность архива: OK"
  fi

  local age_hours
  age_hours=$(( ( $(date +%s) - $(stat -f %m "${latest}" 2>/dev/null || stat -c %Y "${latest}") ) / 3600 ))
  log "Возраст последней копии: ${age_hours} ч"

  if (( age_hours > 26 )); then
    notify_failure "Последняя копия старше 26 часов — возможен сбой планировщика"
    exit 2
  fi

  do_cleanup
}

do_list() {
  log "Копии в ${BACKUP_DIR}:"
  find "${BACKUP_DIR}" -name 'repair-*' -type f -exec ls -lh {} \; 2>/dev/null | awk '{print "  " $5 "\t" $9}' || true
}

do_cleanup() {
  log "Удаляю копии старше ${RETENTION_DAYS} дней"
  find "${BACKUP_DIR}" -name 'repair-*' -type f -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true
  log "Очистка завершена"
}

# --- Точка входа -------------------------------------------------------------

main() {
  local command="${1:-files}"

  case "${command}" in
    files)  do_files;  do_cleanup ;;
    config) do_config; do_cleanup ;;
    verify) do_verify ;;
    list)   do_list ;;
    *)
      cat >&2 <<EOF
Использование: $0 {files|config|verify|list}

  files   — выгрузить файлы проекта (фото, записи, PDF) — ежедневно
  config  — выгрузить конфигурацию — еженедельно
  verify  — проверить свежесть и целостность последней копии
  list    — показать существующие копии

Резервное копирование БАЗЫ ДАННЫХ выполняет администратор PostgreSQL
предприятия: infra/db/README.md §5.
EOF
      exit 1
      ;;
  esac

  log "Готово"
}

main "$@"