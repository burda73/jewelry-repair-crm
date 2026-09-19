#!/usr/bin/env bash
#
# Развёртывание системы на сервере (LXC, без Docker).
#
# ЗАЧЕМ СКРИПТ: два дефекта развёртывания возникали повторно и находились только
# в браузере, потому что сервер отвечал 200. Оба шага легко забыть вручную:
#
#   1. `prisma generate` после `npm ci` (иначе сборка API падает с ошибками
#      типов Prisma) — см. infra/db/deployment-report.md §5.7;
#   2. копирование `.next/static` и `public` в standalone-сборку (иначе страницы
#      пустые: HTML ссылается на чанки, которых нет) — §5.8.
#
# Скрипт выполняет шаги в правильном порядке и проверяет результат.
#
# Использование:
#   ./scripts/deploy.sh                 # развернуть на сервер по умолчанию
#   SERVER=root@10.0.0.5 ./scripts/deploy.sh
#   ./scripts/deploy.sh --skip-sync     # только пересборка и перезапуск
#
# Требования: SSH-доступ по ключу под root, rsync на обеих машинах.

set -euo pipefail

SERVER="${SERVER:-root@192.168.2.188}"
APP_DIR="/opt/repair/app"
# Данные, которые не должны теряться при пересборке: фото изделий.
DATA_DIR="/opt/repair/data"
SERVICE_USER="repair"
SKIP_SYNC=0

for arg in "$@"; do
  case "$arg" in
    --skip-sync) SKIP_SYNC=1 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }

# --- 1. Передача кода -------------------------------------------------------
# Исключения обязательны: `node_modules` с чужой архитектурой сломает установку,
# `.next` и `dist` создаются на сервере, `*.tsbuildinfo` заставит `tsc -b`
# пропустить сборку (устаревший файл считает её актуальной), `.env` хранит
# боевые секреты и на сервере свой.
if [ "$SKIP_SYNC" -eq 0 ]; then
  step "Передача кода на $SERVER"
  rsync -a --delete \
    --no-owner --no-group --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
    --exclude node_modules \
    --exclude .next \
    --exclude dist \
    --exclude '*.tsbuildinfo' \
    --exclude .env \
    --exclude .git \
    --exclude .local \
    "$ROOT_DIR/" "$SERVER:$APP_DIR/"
  ok "код передан"
fi

# --- 2. Владелец файлов ----------------------------------------------------
# Без этого сервис не прочитает файлы: `rsync` сохраняет UID рабочей машины,
# которого на сервере нет. Симптом — `Cannot find module '@app/shared'`.
step "Выставление владельца файлов"
ssh "$SERVER" "chown -R $SERVICE_USER:$SERVICE_USER $APP_DIR"
ok "владелец $SERVICE_USER"

# --- 2.1. Каталог файлов ---------------------------------------------------
# Фотографии изделий лежат ВНЕ каталога приложения: пересборка и `rsync`
# не должны их затрагивать, а резервное копирование — забирать их отдельно
# от кода. Каталог создаётся здесь, иначе первая загрузка фото упала бы с
# ENOENT (приложение создаёт его при старте, но владелец к этому моменту
# ещё не выставлен, если каталог появляется от root).
step "Каталог файлов (фото изделий)"
ssh "$SERVER" "mkdir -p $DATA_DIR/files && chown -R $SERVICE_USER:$SERVICE_USER $DATA_DIR"
ok "каталог $DATA_DIR/files готов"

# --- 3. Зависимости --------------------------------------------------------
# `npm ci` пересоздаёт node_modules, поэтому Prisma Client нужно сгенерировать
# заново. Это делает postinstall, но проверяем явно — шаг критичен для сборки.
step "Установка зависимостей и генерация Prisma Client"
ssh "$SERVER" "su $SERVICE_USER -s /bin/bash -c '
  set -e
  cd $APP_DIR
  npm ci >/tmp/npm-ci.log 2>&1 || { tail -20 /tmp/npm-ci.log; exit 1; }
  test -s node_modules/.prisma/client/index.d.ts || {
    echo \"Prisma Client не сгенерирован (postinstall не сработал)\"; exit 1;
  }
  # Заглушка Prisma весит ~4 КБ; сгенерированный клиент — сотни килобайт.
  size=\$(wc -c < node_modules/.prisma/client/index.d.ts)
  if [ \"\$size\" -lt 100000 ]; then
    echo \"Prisma Client выглядит как заглушка (\$size байт) — генерирую\"
    DATABASE_URL=\"\${DATABASE_URL:-postgresql://placeholder/placeholder}\" \
      npx prisma generate --schema packages/db/prisma/schema.prisma
  fi
  echo \"    Prisma Client: \$size байт\"
'"
ok "зависимости установлены, Prisma Client готов"

# --- 3.1. Миграции БД ------------------------------------------------------
# Без этого шага миграции применялись вручную: код обновлялся, а схема БД
# оставалась прежней. Симптом — приложение падает на обращении к новому
# столбцу, причём уже после перезапуска сервисов, когда откат неочевиден.
# `migrate deploy` применяет только неприменённые миграции и не меняет данные.
step "Применение миграций БД"
ssh "$SERVER" "su $SERVICE_USER -s /bin/bash -c '
  set -e
  cd $APP_DIR
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
'"
ok "схема БД актуальна"

# --- 4. Сборка -------------------------------------------------------------
step "Сборка shared, API и веб"
ssh "$SERVER" "su $SERVICE_USER -s /bin/bash -c '
  set -e
  cd $APP_DIR
  # Устаревший tsbuildinfo заставляет tsc считать сборку актуальной.
  rm -f packages/*/tsconfig.tsbuildinfo apps/*/tsconfig.tsbuildinfo
  npx tsc -b packages/shared
  npm run build --workspace @app/api >/tmp/api-build.log 2>&1 || { tail -30 /tmp/api-build.log; exit 1; }
  npm run build --workspace @app/web >/tmp/web-build.log 2>&1 || { tail -30 /tmp/web-build.log; exit 1; }
'"
ok "shared, API и веб собраны"

# --- 5. Статика standalone -------------------------------------------------
# `output: 'standalone'` не копирует эти каталоги: в Docker это делает сборщик
# образа. Без них страницы отвечают 200, но остаются пустыми — чанки 404,
# гидратация не запускается.
step "Копирование статики в standalone-сборку"
ssh "$SERVER" "su $SERVICE_USER -s /bin/bash -c '
  set -e
  cd $APP_DIR/apps/web
  test -d .next/static || { echo \"Нет .next/static — сборка веба не выполнена\"; exit 1; }
  mkdir -p .next/standalone/apps/web/.next
  cp -r .next/static .next/standalone/apps/web/.next/static
  test -d public && cp -r public .next/standalone/apps/web/public || true
'"
ok "статика скопирована"

# --- 6. Шаблоны уведомлений ------------------------------------------------
# ЗАЧЕМ ЭТОТ ШАГ. Шаблоны — настроечные данные, и сид в продакшне не запускают:
# он создаёт демонстрационные заказы и учётные записи. Пока список шаблонов жил
# только в сиде, новый шаблон не появлялся на сервере, и уведомление уходило по
# ЗАПАСНОМУ тексту — работало, но не так, как задумано, и заметить это можно
# было только прочитав сообщение. Скрипт добавляет недостающие шаблоны и
# сообщает о расхождении текстов, не перезаписывая их.
step "Синхронизация шаблонов уведомлений"
ssh "$SERVER" "su $SERVICE_USER -s /bin/bash -c '
  set -e
  cd $APP_DIR
  /usr/bin/node scripts/sync-templates.mjs
'"
ok "шаблоны уведомлений синхронизированы"

# --- 7. Юниты systemd ------------------------------------------------------
# ЗАЧЕМ ЭТОТ ШАГ. Юнит воркера существовал только в документации: `deploy.sh`
# перезапускал `repair-api` и `repair-web`, а `repair-worker` не устанавливался и
# не запускался вообще. Воркер эскалаций и автостатуса «Невостребовано» при этом
# собирался и лежал в `dist/`, но не работал — а его отсутствие не видно: API
# отвечает 200, страницы открываются, просто уведомления никогда не приходят.
#
# Юниты копируются из репозитория при каждом развёртывании: правка на сервере
# руками терялась бы при следующей установке и нигде не была бы видна.
step "Установка юнитов systemd"
for unit in repair-api repair-web repair-worker; do
  scp -q "$ROOT_DIR/infra/systemd/$unit.service" "$SERVER:/etc/systemd/system/$unit.service"
done
ssh "$SERVER" 'systemctl daemon-reload'
ok "юниты установлены из infra/systemd"

# --- 8. Перезапуск и проверка ---------------------------------------------
step "Перезапуск сервисов"
ssh "$SERVER" "systemctl restart repair-api repair-web && sleep 8"
ssh "$SERVER" 'systemctl is-active --quiet repair-api' || { echo "repair-api не запустился" >&2; exit 1; }
ssh "$SERVER" 'systemctl is-active --quiet repair-web' || { echo "repair-web не запустился" >&2; exit 1; }
ok "repair-api и repair-web активны"

# Воркер перезапускается отдельно: на первом развёртывании он ещё не был
# `enabled`, поэтому нужен и `enable`.
#
# ЗАЧЕМ ИМЕННО `restart`, А НЕ `enable --now`. `enable --now` запускает юнит,
# только если тот ОСТАНОВЛЕН; для уже работающего воркера это пустая операция.
# Воркер при этом продолжает крутиться со СТАРЫМ кодом из памяти: новый
# воркер (`claim-deadlines`, задача 6.6) не появлялся вовсе, а изменения в
# существующих не вступали в силу до ручного перезапуска — и заметить это
# нельзя, потому что API отвечает 200, а страницы открываются.
# Реальный дефект, найденный при развёртывании этапа 6: в журнале воркера
# после трёх развёртываний оставался запуск шестичасовой давности.
step "Включение и перезапуск воркера"
ssh "$SERVER" 'systemctl enable repair-worker >/dev/null 2>&1 || true'
ssh "$SERVER" 'systemctl restart repair-worker'
sleep 3
ssh "$SERVER" 'systemctl is-active --quiet repair-worker' || { echo "repair-worker не запустился — плановые задачи работать не будут" >&2; exit 1; }

# Проверяется, что воркер запустил ИМЕННО текущий набор задач, а не остался на
# прежнем коде. `systemctl is-active` этого не показывает: процесс может быть
# активен, но работать со старым кодом из памяти. Сверяется отметка о запуске
# после рестарта и наличие каждой задачи в журнале.
LAST_START=$(ssh "$SERVER" "systemctl show repair-worker -p ExecMainStartTimestamp --value")
if ssh "$SERVER" "awk -v t='$LAST_START' '\$0 ~ /Запуск фоновых воркеров/ { found=1 } END { exit found?0:1 }' /opt/repair/logs/worker.log"; then
  ok "воркер запускал задачи после перезапуска"
else
  echo "ВНИМАНИЕ: в журнале воркера нет записи о запуске после $LAST_START" >&2
  echo "Проверьте /opt/repair/logs/worker.log: возможно, воркер работает со старым кодом" >&2
fi
ok "repair-worker активен"

# --- 9. Дымовые проверки ---------------------------------------------------
# Проверяем именно то, что ломалось: API отвечает, страница отдаётся, и — главное —
# чанк статики доступен. Без последней проверки «пустая страница» проходит незамеченной.
step "Дымовые проверки"
ssh "$SERVER" '
  set -e
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/health/ready)
  [ "$code" = "200" ] || { echo "API health: $code"; exit 1; }
  echo "    API health/ready: $code"

  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login)
  [ "$code" = "200" ] || { echo "Веб /login: $code"; exit 1; }
  echo "    Веб /login: $code"

  # Берём реальный чанк из HTML и проверяем, что он отдаётся со статусом 200.
  chunk=$(curl -s http://localhost:3000/login | grep -o "/_next/static/chunks/[^\"]*\.js" | head -1)
  [ -n "$chunk" ] || { echo "В HTML нет ссылок на чанки"; exit 1; }
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$chunk")
  [ "$code" = "200" ] || { echo "Статика $chunk: $code (страницы будут пустыми)"; exit 1; }
  echo "    Статика $chunk: $code"

  # Файлы PWA. Их отсутствие не видно нигде, кроме телефона: приложение просто
  # не устанавливается на домашний экран, без единой ошибки в интерфейсе.
  # Так уже было — манифест ссылался на несуществующие иконки (дефект 27),
  # и на проде оба адреса отдавали 404.
  for pwa_file in /manifest.webmanifest /sw.js /offline.html /icons/icon-192.png /icons/icon-512.png; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$pwa_file")
    [ "$code" = "200" ] || { echo "PWA $pwa_file: $code (установка на домашний экран не сработает)"; exit 1; }
  done
  echo "    Файлы PWA (манифест, воркер, иконки): 200"
'
ok "развёртывание подтверждено"

# Публичный адрес указывается вместо внутреннего: порт 3000 на LXC — это адрес ЗА
# прокси заказчика, и по HTTP вход в браузере не работает. Cookie помечены Secure,
# поэтому браузер их не сохранит, и пользователь увидит циклический возврат на
# экран входа. Раньше скрипт предлагал именно этот адрес — то есть подсказывал
# заведомо нерабочий способ входа.
PUBLIC_URL="${PUBLIC_URL:-https://repair.remixgold.ru}"
printf '\n\033[1;32mГотово.\033[0m Проверьте интерфейс в браузере: %s\n' "$PUBLIC_URL"
printf 'Внутренний адрес (только для диагностики, вход не работает): http://%s:3000\n' \
  "$(echo "$SERVER" | cut -d@ -f2)"
