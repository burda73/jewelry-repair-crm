#!/usr/bin/env bash
#
# Учебное восстановление из резервной копии БАЗЫ (docs/10-nfr-security.md §5).
# ЦЕЛЬ: убедиться, что копия РАБОТАЕТ, а не просто создаётся.
#
# ВАЖНО — ИЗМЕНЕНИЕ ПО ОТВЕТУ A1:
#   PostgreSQL теперь ВНЕШНИЙ — существующий сервер предприятия, ОБЩИЙ с другими
#   системами. Резервные копии делает администратор БД, поэтому дамп нужно
#   получить у него: infra/db/README.md §5.
#
#   Поскольку сервер общий, учебное восстановление НАГРУЖАЕТ его (создание БД,
#   запись данных, место на диске). Поэтому:
#     • согласуйте время с администратором БД;
#     • по возможности выполняйте на ОТДЕЛЬНОМ стенде, а не на продакшн-сервере;
#     • обязательно удалите учебную БД после проверки (команда в конце вывода).
#
# Запускается ЕЖЕКВАРТАЛЬНО. Результат оформляется актом.
# Замеряет фактический RTO и сравнивает с целевым (≤ 4 часа).
#
# Использование:
#   ./restore-drill.sh /path/to/repair-....dump
#
# Скрипт восстанавливает в ОТДЕЛЬНУЮ БД (repair_drill) — рабочая не затрагивается.

set -Eeuo pipefail

DUMP_FILE="${1:?укажите путь к дампу}"
TARGET_DB="${TARGET_DB:-repair_drill}"
# ADMIN_URL — подключение к внешнему PostgreSQL с правами CREATE DATABASE
# (обычно роль администратора БД, не наша рабочая роль).
ADMIN_URL="${ADMIN_URL:?задайте ADMIN_URL, напр. postgresql://postgres@pg-server:5432/postgres}"
TARGET_URL="${TARGET_URL:-${ADMIN_URL%/*}/${TARGET_DB}}"
RTO_TARGET_MINUTES="${RTO_TARGET_MINUTES:-240}"  # 4 часа

log() { echo "[restore-drill $(date '+%H:%M:%S')] $*"; }

[[ -f "${DUMP_FILE}" ]] || { echo "Файл не найден: ${DUMP_FILE}" >&2; exit 1; }

log "=== УЧЕБНОЕ ВОССТАНОВЛЕНИЕ ==="
log "Дамп:        ${DUMP_FILE}"
log "Целевая БД:  ${TARGET_DB}"
log "Целевой RTO: ${RTO_TARGET_MINUTES} мин"
echo

START_TS=$(date +%s)

# Шаг 1: проверка целостности дампа ДО восстановления
log "Шаг 1/6: проверка целостности дампа"
pg_restore --list "${DUMP_FILE}" >/dev/null \
  || { echo "Дамп повреждён — восстановление невозможно" >&2; exit 1; }
TABLE_COUNT=$(pg_restore --list "${DUMP_FILE}" | grep -c 'TABLE DATA' || true)
log "  Дамп читается. Таблиц с данными: ${TABLE_COUNT}"

# Шаг 2: создание чистой БД
log "Шаг 2/6: создание чистой БД ${TARGET_DB}"
psql "${ADMIN_URL}" -q -c "DROP DATABASE IF EXISTS ${TARGET_DB};" \
  || { echo "Не удалось удалить старую БД (возможно, есть активные подключения)" >&2; exit 1; }
psql "${ADMIN_URL}" -q -c "CREATE DATABASE ${TARGET_DB};"
log "  БД создана"

# Шаг 3: восстановление
log "Шаг 3/6: восстановление данных (это может занять время)"
pg_restore --dbname="${TARGET_URL}" --no-owner --no-acl --jobs=4 "${DUMP_FILE}" 2>&1 \
  | grep -v 'already exists' | head -20 || true
log "  Восстановление завершено"

# Шаг 4: проверка целостности данных
log "Шаг 4/6: проверка восстановленных данных"
ORDER_COUNT=$(psql "${TARGET_URL}" -tAc "SELECT COUNT(*) FROM \"order\";" 2>/dev/null || echo "0")
USER_COUNT=$(psql "${TARGET_URL}" -tAc "SELECT COUNT(*) FROM \"user\";" 2>/dev/null || echo "0")
PAYMENT_SUM=$(psql "${TARGET_URL}" -tAc \
  "SELECT COALESCE(SUM(amount_minor),0) FROM payment WHERE status='CONFIRMED';" 2>/dev/null || echo "0")

log "  Заказов:            ${ORDER_COUNT}"
log "  Пользователей:      ${USER_COUNT}"
log "  Сумма платежей:     ${PAYMENT_SUM} коп."

(( ORDER_COUNT > 0 )) || { echo "В восстановленной БД нет заказов — восстановление некорректно" >&2; exit 1; }

# Шаг 5: проверка бизнес-инвариантов
log "Шаг 5/6: проверка бизнес-инвариантов"
# Инвариант: paidAmountMinor должен совпадать с суммой подтверждённых платежей
MISMATCH=$(psql "${TARGET_URL}" -tAc "
  SELECT COUNT(*) FROM \"order\" o
  WHERE o.paid_amount_minor <> COALESCE((
    SELECT SUM(p.amount_minor) FROM payment p
    WHERE p.order_id = o.id AND p.status = 'CONFIRMED'
      AND p.kind NOT IN ('REFUND','REVERSAL')
  ), 0);
" 2>/dev/null || echo "ERR")

if [[ "${MISMATCH}" == "ERR" ]]; then
  log "  ПРЕДУПРЕЖДЕНИЕ: не удалось проверить инвариант оплат"
elif [[ "${MISMATCH}" == "0" ]]; then
  log "  Инвариант «оплачено = сумма платежей» соблюдён"
else
  echo "НАЙДЕНО РАСХОЖДЕНИЙ: ${MISMATCH} заказов — требуется разбор" >&2
fi

# Шаг 6: итог и замер RTO
log "Шаг 6/6: итоги"
END_TS=$(date +%s)
ELAPSED_MIN=$(( (END_TS - START_TS) / 60 ))
ELAPSED_SEC=$(( (END_TS - START_TS) % 60 ))

echo
log "=== РЕЗУЛЬТАТ ==="
log "Фактический RTO: ${ELAPSED_MIN} мин ${ELAPSED_SEC} сек"
log "Целевой RTO:     ${RTO_TARGET_MINUTES} мин"

if (( ELAPSED_MIN <= RTO_TARGET_MINUTES )); then
  log "СТАТУС: ВОССТАНОВЛЕНИЕ УСПЕШНО, RTO в норме"
else
  log "СТАТУС: RTO ПРЕВЫШЕН — требуется оптимизация процедуры"
  exit 3
fi

echo
log "Проверьте вручную:"
log "  1. Открывается ли карточка случайного заказа"
log "  2. Совпадают ли итоговые суммы в отчёте «Выручка» с ожидаемыми"
log "  3. Доступны ли файлы из S3 (они восстанавливаются отдельно — репликацией)"
echo
log "Не забудьте удалить учебную БД: psql \"${ADMIN_URL}\" -c 'DROP DATABASE ${TARGET_DB};'"
log "Оформите акт о проведении учебного восстановления."