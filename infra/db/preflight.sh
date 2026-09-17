#!/usr/bin/env bash
#
# Проверка готовности внешнего PostgreSQL 16 перед развёртыванием.
#
# ВАЖНО: БД — существующий сервер предприятия (ответ A1), общий с другими
# системами. Этот скрипт проверяет, что наша роль имеет всё необходимое и
# НЕ занимает лишние соединения. Запускается ДО первого деплоя.
#
# Использование:
#   DATABASE_URL="postgresql://repair_app:...@pg-server:5432/repair" ./infra/db/preflight.sh
#   или скопируйте .env рядом и запустите: ./infra/db/preflight.sh
#
# Возвращает 0, если всё готово. Ненулевой код — есть блокирующие проблемы.

set -Eeuo pipefail

# --- Конфигурация -----------------------------------------------------------
# Подхватываем .env, если он есть (не перезаписывая уже заданные переменные).
if [[ -f .env ]]; then
  while IFS='=' read -r key value; do
    [[ "${key}" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [[ -n "${!key:-}" ]] && continue
    value="${value%\"}"; value="${value#\"}"
    export "${key}=${value}"
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' .env || true)
fi

DATABASE_URL="${DATABASE_URL:?DATABASE_URL не задан. Задайте строку подключения к внешнему PostgreSQL}"
POOL_SIZE="${DATABASE_POOL_SIZE:-10}"
# Ожидаемое число процессов: 2 реплики API + 1 воркер.
PROCESS_COUNT="${PROCESS_COUNT:-3}"

# Цвета для наглядности (отключаются, если вывод не терминал).
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; NC=''
fi

PROBLEMS=0
WARNINGS=0

ok()   { printf '  %s✓%s %s\n' "${GREEN}" "${NC}" "$*"; }
bad()  { printf '  %s✗%s %s\n' "${RED}" "${NC}" "$*"; PROBLEMS=$((PROBLEMS + 1)); }
warn() { printf '  %s!%s %s\n' "${YELLOW}" "${NC}" "$*"; WARNINGS=$((WARNINGS + 1)); }
head_() { printf '\n%s%s%s\n' "${BOLD}" "$*" "${NC}"; }

# Выполнить запрос, вернуть одну строку. Ошибку гасим — обрабатываем сами.
q() {
  psql "${DATABASE_URL}" -tA -X -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

command -v psql >/dev/null 2>&1 || {
  echo "ОШИБКА: psql не найден. Установите postgresql-client:" >&2
  echo "  apt install postgresql-client-16   # или эквивалент для вашей ОС" >&2
  exit 127
}

echo "${BOLD}=== Проверка готовности внешнего PostgreSQL ===${NC}"
# Пароль в вывод не попадаем: показываем только хост, порт и БД.
SAFE_URL="$(printf '%s' "${DATABASE_URL}" | sed -E 's#(://[^:]+):[^@]*@#\1:***@#')"
echo "  Подключение: ${SAFE_URL}"
echo "  Пул на процесс: ${POOL_SIZE}, процессов: ${PROCESS_COUNT}"

# --- 1. Доступность и версия ------------------------------------------------
head_ "1. Подключение и версия"

VERSION_RAW="$(q "SHOW server_version;")" || true
if [[ "${VERSION_RAW}" == *"error"* || "${VERSION_RAW}" == *"ОШИБКА"* || -z "${VERSION_RAW}" ]]; then
  bad "Не удалось подключиться к серверу БД"
  echo "     Ответ сервера: ${VERSION_RAW}" >&2
  echo ""
  echo "     Что проверить:"
  echo "       • данные подключения (хост, порт, имя БД, логин, пароль);"
  echo "       • доступность 5432 с этого хоста: nc -vz pg-server 5432"
  echo "       • правило в pg_hba.conf для адреса этого хоста;"
  echo "       • метод аутентификации scram-sha-256."
  exit 1
fi

MAJOR="${VERSION_RAW%%.*}"
if [[ "${MAJOR}" == "16" ]]; then
  ok "PostgreSQL ${VERSION_RAW} — версия соответствует требуемой (16)"
else
  bad "PostgreSQL ${VERSION_RAW} — проект рассчитан на версию 16"
  echo "     На других версиях схема может не примениться без правок."
fi

SERVER_ADDR="$(q "SELECT inet_server_addr()::text || ':' || inet_server_port()::text;")" || true
ok "Подключены к серверу ${SERVER_ADDR}"

# --- 2. Права роли ----------------------------------------------------------
head_ "2. Права роли приложения"

CURRENT_USER="$(q "SELECT current_user;")" || true
IS_SUPER="$(q "SELECT usesuper FROM pg_user WHERE usename = current_user;")" || true

if [[ "${IS_SUPER}" == "t" ]]; then
  warn "Роль «${CURRENT_USER}» — суперпользователь."
  echo "     Приложение НЕ должно работать под суперпользователем: сервер общий,"
  echo "     ошибка сможет повредить чужие базы. Создайте отдельную роль (infra/db/README.md §1.2)."
else
  ok "Роль «${CURRENT_USER}» не суперпользователь"
fi

# Право CREATE в схеме — необходимо Prisma для миграций.
CAN_CREATE="$(q "SELECT has_schema_privilege(current_user, 'public', 'CREATE');")" || true
if [[ "${CAN_CREATE}" == "t" ]]; then
  ok "Есть право CREATE в схеме public (нужно для миграций)"
else
  bad "Нет права CREATE в схеме public — prisma migrate deploy упадёт"
  echo "     Исправление: GRANT CREATE ON SCHEMA public TO ${CURRENT_USER};"
fi

# Проверка фактическим DDL: самый надёжный способ.
PROBE="$(q "CREATE TABLE __preflight_probe(id int); DROP TABLE __preflight_probe; SELECT 'ok';")" || true
if [[ "${PROBE}" == "ok" ]]; then
  ok "Создание и удаление таблицы выполняется (DDL доступен)"
else
  bad "Не удалось выполнить DDL от имени роли приложения"
  echo "     Ответ: ${PROBE}"
fi

# --- 3. Расширения ----------------------------------------------------------
head_ "3. Расширения"

for ext in pg_trgm btree_gin; do
  HAS_EXT="$(q "SELECT 1 FROM pg_extension WHERE extname = '${ext}';")" || true
  if [[ "${HAS_EXT}" == "1" ]]; then
    ok "Расширение ${ext} установлено"
  else
    AVAIL="$(q "SELECT 1 FROM pg_available_extensions WHERE name = '${ext}';")" || true
    if [[ "${AVAIL}" == "1" ]]; then
      bad "Расширение ${ext} доступно, но НЕ установлено"
      echo "     Установка суперпользователем: CREATE EXTENSION IF NOT EXISTS ${ext};"
    else
      bad "Расширение ${ext} недоступно на сервере"
      echo "     Проверьте пакет postgresql-contrib-16 на сервере БД."
    fi
    echo "     Без pg_trgm не работает нечёткий поиск по ФИО (ТЗ п. 2.1)."
  fi
done

# --- 4. Бюджет соединений ---------------------------------------------------
head_ "4. Бюджет соединений (сервер общий!)"

MAX_CONN="$(q "SHOW max_connections;")" || true
RESERVED="$(q "SHOW superuser_reserved_connections;")" || true
OUR_NEED=$(( POOL_SIZE * PROCESS_COUNT ))

if [[ "${MAX_CONN}" =~ ^[0-9]+$ ]]; then
  AVAILABLE=$(( MAX_CONN - RESERVED ))
  PERCENT=$(( OUR_NEED * 100 / MAX_CONN ))
  echo "     max_connections=${MAX_CONN}, зарезервировано суперпользователю=${RESERVED}"
  echo "     Наш пул: ${POOL_SIZE} × ${PROCESS_COUNT} процессов = ${OUR_NEED} соединений (${PERCENT}%)"

  if (( OUR_NEED > AVAILABLE / 2 )); then
    bad "Наш пул займёт больше половины доступных соединений сервера"
    echo "     Сервер ОБЩИЙ (с ним работают 1С и другие системы). Уменьшите"
    echo "     DATABASE_POOL_SIZE или согласуйте увеличение max_connections."
  else
    ok "Пул в допустимых пределах — другим системам остаётся $(( AVAILABLE - OUR_NEED )) соединений"
  fi

  LIMIT="$(q "SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user;")" || true
  if [[ "${LIMIT}" == "-1" ]]; then
    warn "У роли нет CONNECTION LIMIT — рекомендуется ограничить (защита сервера)"
    echo "     ALTER ROLE ${CURRENT_USER} CONNECTION LIMIT 40;"
  elif [[ "${LIMIT}" =~ ^[0-9]+$ ]]; then
    if (( LIMIT < OUR_NEED )); then
      bad "CONNECTION LIMIT роли (${LIMIT}) меньше требуемого пула (${OUR_NEED})"
    else
      ok "CONNECTION LIMIT роли: ${LIMIT}"
    fi
  fi
else
  warn "Не удалось определить max_connections"
fi

# Текущая загрузка — чтобы понимать ситуацию на общем сервере.
ACTIVE="$(q "SELECT count(*) FROM pg_stat_activity WHERE datname IS NOT NULL;")" || true
if [[ "${ACTIVE}" =~ ^[0-9]+$ ]]; then
  ok "Активных соединений на сервере сейчас: ${ACTIVE}"
fi

# --- 5. Локаль базы ---------------------------------------------------------
head_ "5. Локаль базы данных (сортировка ФИО)"

LOCALE="$(q "SELECT datcollate FROM pg_database WHERE datname = current_database();")" || true
if [[ "${LOCALE}" == "C" || "${LOCALE}" == "POSIX" ]]; then
  bad "Локаль базы: ${LOCALE} — русские ФИО будут сортироваться неверно"
  echo "     Требуется ru_RU.UTF-8. Исправляется только пересозданием БД —"
  echo "     лучше сделать это сейчас, до наполнения данными."
elif [[ "${LOCALE}" == *"ru_RU"* ]]; then
  ok "Локаль базы: ${LOCALE}"
else
  warn "Локаль базы: ${LOCALE} — отличается от рекомендуемой ru_RU.UTF-8"
fi

# --- 6. Часы ----------------------------------------------------------------
head_ "6. Часы сервера БД"

DRIFT="$(q "SELECT EXTRACT(EPOCH FROM (now() - statement_timestamp()))::int;")" || true
CLOCK="$(q "SELECT now();")" || true
ok "Время сервера БД: ${CLOCK}"
echo "     Убедитесь, что сервер БД и хост приложения имеют синхронное время (NTP)."
echo "     Расхождение ломает расчёт дедлайнов и сопоставление звонков (ТЗ п. 2.7, 2.4)."

# --- 7. Версия таблиц (если БД уже используется) -----------------------------
head_ "7. Состояние схемы"

TABLE_COUNT="$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")" || true
if [[ "${TABLE_COUNT}" =~ ^[0-9]+$ ]]; then
  if (( TABLE_COUNT == 0 )); then
    ok "База пуста (${TABLE_COUNT} таблиц) — готова к первой миграции"
  else
    ok "В базе ${TABLE_COUNT} таблиц в схеме public"
    MIGRATIONS="$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" 2>/dev/null)" || true
    if [[ "${MIGRATIONS}" =~ ^[0-9]+$ ]]; then
      echo "     Применённых миграций Prisma: ${MIGRATIONS}"
    fi
    echo "     ВНИМАНИЕ: если база не наша или содержит чужие таблицы —"
    echo "     использовать её категорически нельзя. Проект требует отдельную БД."
  fi
fi

# --- Итог -------------------------------------------------------------------
head_ "=== ИТОГ ==="
if (( PROBLEMS == 0 && WARNINGS == 0 )); then
  printf '  %sВсё готово к развёртыванию.%s\n' "${GREEN}" "${NC}"
elif (( PROBLEMS == 0 )); then
  printf '  %sГотово, но есть замечания: %d.%s\n' "${YELLOW}" "${WARNINGS}" "${NC}"
  echo "  Блокирующих проблем нет — можно начинать развёртывание."
else
  printf '  %sБлокирующих проблем: %d.%s\n' "${RED}" "${PROBLEMS}" "${NC}"
  echo "  Развёртывание начнётся только после их устранения."
  echo "  Подробности и точные команды — infra/db/README.md"
fi

echo ""
echo "  Дальнейшие шаги:"
echo "    1. Согласовать с администратором БД резервное копирование и PITR (README §5)."
echo "    2. Развернуть приложение: docker compose -f infra/docker/docker-compose.prod.yml up -d"
echo "    3. Применить миграции (отдельным шагом, до переключения трафика)."
echo "    4. Добавить ограничения CHECK и запрет изменения audit_log (migrations/README.md §4, §6)."
echo ""

(( PROBLEMS == 0 )) || exit 1
exit 0