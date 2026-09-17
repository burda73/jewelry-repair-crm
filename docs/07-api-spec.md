# 06. Спецификация API

Базовый путь: `/api/v1`. Формат — JSON. Аутентификация — JWT в httpOnly-cookie.
Каждый ответ с ошибкой имеет единый формат. Спецификация генерируется автоматически
(`@nestjs/swagger`) и доступна на `/api/docs` в средах dev/staging.

## 1. Общие правила

### 1.1. Формат ошибки

```json
{
  "statusCode": 409,
  "code": "PREPAYMENT_REQUIRED",
  "message": "Старт работ заблокирован: предоплата 3000 ₽ не внесена",
  "details": { "requiredMinor": 300000, "paidMinor": 0 },
  "requestId": "01J8Z..."
}
```

Машиночитаемый `code` — часть контракта, фронтенд ориентируется на него, а не на текст.

### 1.2. Пагинация (keyset)

```
GET /orders?limit=50&cursor=eyJjIjoiMjAyNS0wOS0xNVQxMDowMDowMFoiLCJpIjoiY20xIn0
```

```json
{
  "items": [ ... ],
  "nextCursor": "eyJjIjoi...",
  "hasMore": true
}
```

`OFFSET` не используется — на больших объёмах он деградирует.

### 1.3. Идемпотентность

Мутирующие запросы, влияющие на деньги (`POST /payments`), принимают заголовок
`Idempotency-Key`. Повтор с тем же ключом возвращает результат первой операции,
а не создаёт дубль.

### 1.4. Оптимистичная блокировка

`PATCH /orders/:id` и `PUT /orders/:id/works` принимают `version`. При расхождении:
`409 STALE_VERSION` + актуальный объект в `details`.

## 2. Аутентификация

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| POST | `/auth/login` | Вход по email + пароль | — |
| POST | `/auth/refresh` | Обновление access-токена (ротация refresh) | — |
| POST | `/auth/logout` | Выход, отзыв сессии | все |
| GET | `/auth/me` | Текущий пользователь, роли, права, магазины | все |
| POST | `/auth/change-password` | Смена пароля | все |
| POST | `/auth/logout-all` | Отзыв всех сессий | все |

`GET /auth/me` возвращает **вычисленный список прав** (`permissions: string[]`) и области
видимости — фронтенд не дублирует матрицу прав, а доверяет серверу.

## 3. Заказы

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| GET | `/orders` | Список с фильтрами и пагинацией | по scope |
| POST | `/orders` | Создать заказ (черновик) | RECEIVER, ADMIN |
| GET | `/orders/:id` | Карточка заказа (полная) | по scope |
| PATCH | `/orders/:id` | Изменить (требует `version`) | по scope + права |
| GET | `/orders/search` | **Глобальный** поиск по номеру/телефону/ФИО | все |
| GET | `/orders/:id/history` | История статусов | по scope |
| GET | `/orders/:id/timeline` | Единая лента: статусы + платежи + согласования | по scope |
| POST | `/orders/:id/transition` | Переход статуса | по таблице переходов |
| GET | `/orders/:id/available-transitions` | Какие переходы доступны текущему пользователю | по scope |
| POST | `/orders/:id/cancel` | Отмена (причина обязательна) | RECEIVER, PRODUCTION_MANAGER, MANAGER, ADMIN |
| GET | `/orders/overdue` | Просроченные (дашборд) | MANAGER, ADMIN, PRODUCTION_MANAGER |

**Фильтры списка:** `status[]`, `storeId[]`, `createdFrom`, `createdTo`, `dueTo`,
`customerPhone`, `orderNo`, `isWarranty`, `priority`, `overdue=true`, `productionManagerId`.

**`POST /orders/:id/transition`**
```json
{ "to": "IN_PRODUCTION", "reason": "Партия принята цехом", "version": 4,
  "payload": { "performerId": "cm...", "plannedHours": 6 } }
```
Ответ `409` с `code` из списка: `INVALID_TRANSITION`, `PREPAYMENT_REQUIRED`,
`NOT_PAID_IN_FULL`, `APPROVAL_MISSING`, `CONSENT_REQUIRED`, `FORBIDDEN_ROLE`.

## 4. Изделия и файлы

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/orders/:id/items` | Добавить изделие |
| PATCH | `/items/:id` | Изменить изделие |
| DELETE | `/items/:id` | Удалить (только в DRAFT) |
| POST | `/items/:id/photos` | Зарегистрировать загруженный файл |
| POST | `/files/presigned-upload` | Получить presigned URL для загрузки в S3 |
| GET | `/files/:id/url` | Подписанная ссылка на скачивание (TTL 15 мин) |
| DELETE | `/files/:id` | Удалить файл |

## 5. Калькуляция

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| GET | `/orders/:id/calc` | Полная калькуляция с итогами | по scope |
| PUT | `/orders/:id/works` | Заменить строки работ (в DRAFT) | RECEIVER, PRODUCTION_MANAGER, ADMIN |
| POST | `/orders/:id/works` | Добавить строку работы | то же |
| PATCH | `/orders/:id/works/:workId` | Изменить строку | то же |
| DELETE | `/orders/:id/works/:workId` | Удалить строку | то же |
| POST | `/orders/:id/stones` | Добавить камень | то же |
| PATCH | `/orders/:id/stones/:stoneId` | Изменить камень | то же |
| DELETE | `/orders/:id/stones/:stoneId` | Удалить камень | то же |
| POST | `/orders/:id/adjustments` | **Корректировка с причиной** | RECEIVER, PRODUCTION_MANAGER, MANAGER, ADMIN (`calc:adjust`) |
| GET | `/orders/:id/adjustments` | История корректировок | по scope |


## 6. Согласования и звонки

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/orders/:id/approvals` | Список согласований |
| GET | `/orders/:id/receipt` | **PDF-квитанция** с QR-кодом и `Code128` (`inline`, `no-store`) |
| POST | `/orders/:id/approvals` | Создать согласование (`approval:create`: RECEIVER, PRODUCTION_MANAGER, ADMIN) |
| PATCH | `/approvals/:id` | Изменить результат |
| GET | `/orders/:id/recordings` | Записи звонков по заказу |
| POST | `/orders/:id/recordings/:recId/link` | Привязать запись вручную |
| GET | `/recordings/unmatched` | Неразобранные звонки |
| GET | `/recordings/:id/stream` | Подписанная ссылка на прослушивание |

```json
// Устное согласие (ТЗ п. 2.4)
POST /orders/:id/approvals
{ "channel": "PHONE_VERBAL", "result": "APPROVED",
  "amountMinor": 1250000, "termDays": 10,
  "comment": "Клиент согласился по телефону, запись сохранена" }
```

**`isVerbal` и `promisedAt` в запрос НЕ передаются — их вычисляет сервер:**

| Поле | Как определяется | Почему не от клиента |
|------|------------------|----------------------|
| `isVerbal` | `channel === 'PHONE_VERBAL'` | Это следствие канала, а не отдельный флаг. Иначе запрос `channel: SMS, isVerbal: true` дал бы бейдж «согласовано устно» без устного разговора |
| `promisedAt` | `addWorkingDays(сейчас, termDays)` по производственному календарю | Присланную дату можно поставить на выходной или задним числом, и нормативы этапов (ТЗ п. 2.7) посчитали бы дедлайн неверно |

`approvedAt` заполняется только для `result = APPROVED`: у ответа «не дозвонились»
момента согласия не существует.

**Согласованная сумма может отличаться от суммы заказа.** Тогда сервер фиксирует
корректировку с причиной «Согласование с клиентом (…канал…)», и
`totalAmountMinor` приводится к согласованной сумме. Иначе сумма заказа и
согласованная сумма разошлись бы молча — а клиент подтвердил именно вторую.

```json
// Корректировка калькуляции (ТЗ п. 2.3)
POST /orders/:id/adjustments
{ "targetType": "TOTAL", "amountAfterMinor": 300000, "reason": "Клиент отказался от полировки" }
```

`amountBeforeMinor` и `deltaMinor` вычисляет сервер: если принять «было» от
клиента, в истории окажется сумма, которой в заказе не было.

**Инвариант `totalAmountMinor = worksTotalMinor + stonesTotalMinor − discountMinor`
выполняется всегда** (docs/03-data-model.md §3.2). При согласовании суммы БОЛЬШЕ
суммы строк `discountMinor` становится отрицательным — это надбавка (срочность,
сложность); интерфейс показывает её строкой «Надбавка». Расчёт выполняет
`discountForTotal` из `@app/shared`, а не присваивание итога напрямую.

| Код | Когда |
|-----|-------|
| `409 ADJUSTMENT_BELOW_PAID` | Новая сумма ниже уже внесённой — это возврат, оформляется операцией `REFUND` |
| `409 ORDER_FINAL` | Заказ в терминальном статусе (закрыт, выдан, отменён) |
| `404 NOT_FOUND` | `targetId` не принадлежит этому заказу (не подтверждаем существование чужой строки) |

### 6.1. Квитанция (`GET /orders/:id/receipt`)

Отдаётся готовый PDF (`Content-Type: application/pdf`,
`Content-Disposition: inline`, `Cache-Control: no-store`). Браузер открывает его
во встроенном просмотрщике, откуда печатают на обычном A4 — драйверы и агенты
печати не нужны.

| Что печатается | Откуда берётся |
|----------------|----------------|
| Организация, магазин | `COMPANY_NAME`, `Store.name` |
| Номер заказа крупно, текстом | `Order.orderNo` |
| QR-код | `buildReceiptQr()` → `repair://order/{номер}` |
| Резервный `Code128` | `buildReceiptBarcode()` → номер заказа |
| Изделия, металл, работы, камни | строки заказа, цены на момент приёма |
| Сумма, скидка/надбавка, предоплата, внесено | денежные поля заказа |
| Срок готовности, телефон, статус | `Order.dueAt`, `Customer.phoneNormalized`, статус |
| Строки для подписей сторон | — |

**Это действие, а не чтение.** Каждый запрос увеличивает `Order.receiptPrintCount`
и пишет `Order.receiptLastPrintedAt`, в аудит добавляется `RECEIPT_PRINT` с номером
копии. Перепечатки видны в истории заказа — они защищают от ситуации «клиент принёс
квитанцию, а по ней уже выдали другое изделие».

**Кэширование запрещено** (`no-store`): квитанция содержит ФИО и телефон клиента,
хранить её в браузере или на промежуточном прокси нельзя.

**Область видимости проверяется до увеличения счётчика** — неудачная попытка
напечатать чужой заказ не оставляет следа в его истории и отдаёт `404` (не `403`,
чтобы не подтверждать существование чужого заказа).

**Требования к фону кодов.** `bwip-js` по умолчанию рисует код на ПРОЗРАЧНОМ фоне.
Такой код выглядит верным, но не декодируется ни на одном масштабе, то есть основной
сценарий («сканируем квитанцию») не работает. Фон задан белым явно; проверено
декодированием QR, извлечённого из готовой страницы PDF.

## 6.2. Фотографии изделий (ТЗ п. 2.1)

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| POST | `/orders/:id/items/:itemId/photos` | Загрузить фото (`multipart/form-data`, поле `files`) | `order:update` |
| GET | `/orders/:id/items/:itemId/photos` | Фотографии изделия | `order:read` |
| GET | `/photos/:id` | Файл фото (`?variant=thumb` — уменьшенная копия) | `order:read` |
| DELETE | `/photos/:id` | Удалить фото | `order:update` |

```http
POST /api/v1/orders/:id/items/:itemId/photos
Content-Type: multipart/form-data; boundary=...

files=<файл>[,<файл>...]   // до 10 файлов за запрос
kind=INTAKE                // INTAKE | DEFECT | RESULT | AFTER_REPAIR
caption=Состояние при приёме
```

**Хранилище — локальный диск, раздача через API** (`STORAGE_DRIVER=LOCAL`).
S3/MinIO в инфраструктуре нет (ответ A1), а на диске LXC есть запас. В базе
хранится только ключ объекта (`FileObject.objectKey`), поэтому переезд на S3
не потребует миграции ссылок; драйвер переключается переменной окружения.

**Ответ содержит `url` и `thumbnailUrl` с префиксом `/api/v1`.** Без префикса
ссылка была бы нерабочей: браузер обращается к тому же источнику, что и
интерфейс, а прокси перенаправляет на API только пути `/api/v1/*` — миниатюры
не отображались, хотя файл на сервере был.

**Обработка изображения.** Фото перекодируется в JPEG, уменьшается до 1600 px
по длинной стороне, ориентация из EXIF применяется к пикселям (`rotate()`),
рядом кладётся копия 320 px для списков. Побочный эффект — геометка телефона
сотрудника не сохраняется: фото изделия не должно содержать его персональные
данные.

| Код | Когда |
|-----|-------|
| `400 INVALID_IMAGE` | Файл не является изображением или больше `UPLOAD_MAX_BYTES` |
| `400 INVALID_PHOTO_KIND` | `kind` вне списка видов |
| `400 NO_FILES` | Не передан ни один файл |
| `404 NOT_FOUND` | Заказ вне области видимости, либо изделие не принадлежит заказу |

**Права и область видимости.** Загрузка и удаление требуют `order:update`,
чтение — `order:read`. Область видимости проверяется по **заказу**: чужой
магазин получает `404` (не `403` — не подтверждаем существование заказа).
Файлы отдаются только через API, а не статикой: прямая раздача каталога
открыла бы любой файл по угадываемому адресу.

## 7. Платежи

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| GET | `/orders/:id/payments` | Платежи по заказу | по scope |
| POST | `/orders/:id/payments` | Принять платёж (**идемпотентно**) | CASHIER, ADMIN |
| POST | `/payments/:id/reverse` | Сторно (причина обязательна) | CASHIER (свой магазин), MANAGER, ADMIN |
| GET | `/payments` | Реестр платежей с фильтрами | CASHIER, MANAGER, ADMIN |
| GET | `/payments/sync-status` | Состояние синхронизации с 1С | MANAGER, ADMIN |
| POST | `/payments/:id/retry-sync` | Повторить синхронизацию | ADMIN |

```json
// POST /orders/:id/payments  (Idempotency-Key: <uuid>)
{ "kind": "PREPAYMENT", "method": "CARD", "amountMinor": 300000,
  "storeId": "cm_store_msk2", "receiptNo": "000123",
  "paidAt": "2025-09-15T12:30:00Z", "comment": "Предоплата 30%" }
```

**Ответ содержит** `order.paidAmountMinor`, `order.prepaymentRequiredMinor` и
`order.canStartWork` — фронтенд сразу понимает, снялась ли блокировка.

## 8. Логистика

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| GET | `/batches` | Список партий | PRODUCTION_MANAGER, LOGISTICIAN, MANAGER, ADMIN |
| POST | `/batches` | Создать партию (по графику) | PRODUCTION_MANAGER, LOGISTICIAN |
| GET | `/batches/:id` | Партия с составом | то же |
| POST | `/batches/:id/orders` | Добавить заказы в партию | то же |
| DELETE | `/batches/:id/orders/:orderId` | Убрать заказ (с причиной) | то же |
| POST | `/batches/:id/act` | Сформировать электронный акт | то же |
| POST | `/batches/:id/act/sign` | Подписать со стороны отправителя/получателя | то же |
| GET | `/batches/:id/act/pdf` | Скачать PDF акта | то же |
| POST | `/batches/:id/dispatch` | Отправить (статус «в пути») | LOGISTICIAN |
| POST | `/batches/:id/receive` | Принять партию | PRODUCTION_MANAGER, RECEIVER |
| POST | `/batches/:id/photos` | Фотофиксация партии | LOGISTICIAN |

## 9. Производство

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/performers` | Список исполнителей (ювелиров) |
| POST | `/performers` | Добавить исполнителя |
| PATCH | `/performers/:id` | Изменить |
| GET | `/production/queue` | Очередь работ цеха |
| POST | `/orders/:id/assignments` | Назначить исполнителя |
| PATCH | `/assignments/:id` | Обновить статус работ |
| GET | `/production/load` | Загрузка производства (для отчёта) |

## 10. Прейскурант

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| GET | `/price-lists` | Список версий | все с правом чтения |
| POST | `/price-lists` | Создать черновик версии | ADMIN |
| GET | `/price-lists/:id` | Версия с позициями | то же |
| PATCH | `/price-lists/:id` | Изменить черновик | ADMIN |
| POST | `/price-lists/:id/items` | Добавить позицию | ADMIN |
| PATCH | `/price-list-items/:id` | Изменить позицию | ADMIN |
| DELETE | `/price-list-items/:id` | Удалить позицию | ADMIN |
| POST | `/price-lists/:id/submit` | Отправить на утверждение | ADMIN |
| POST | `/price-lists/:id/approve` | **Утвердить** | MANAGER |
| POST | `/price-lists/:id/reject` | Отклонить (причина) | MANAGER |
| GET | `/price-lists/active` | Активная версия для расчёта | все |
| GET | `/stone-types` | Справочник камней | все с правом чтения |

### 9.1. Цена зависит от металла (ADR 0009)

Утверждённый прейскурант задаёт **две цены** на услугу — по золоту и по серебру.
Металл сданного изделия выбирает ставку.

Позиция в ответах `GET /price-lists/active`, `GET /price-list-items`,
`GET /price-lists/:id` содержит:

| Поле | Смысл |
|------|-------|
| `priceMinor` | цена по умолчанию (по золоту); для позиций без разбивки — единственная |
| `priceFrom` | цена указана как «от» (минимальная) — 5 позиций документа |
| `metalCostSeparate` | стоимость металла в цену не входит, считается отдельно — 3 позиции |
| `unit` | `шт` либо `грамм` (родирование, золочение — 3 позиции) |
| `rates[]` | `{ metal, priceMinor, isFrom }` — ставки по металлам (золото, серебро) |

`costMinor` (себестоимость) в ответ **не включён**: право чтения прейскуранта есть и у
приёмщика, и у кассира, которым маржинальность видеть не нужно.

`POST /orders` принимает `works[].itemIndex` (индекс изделия в `items`, по умолчанию 0) —
по металлу этого изделия подбирается ставка.

**Сервер проверяет присланную цену** и отвечает `409`:

```json
{
  "code": "PRICE_MISMATCH",
  "message": "Цена работы не совпадает с действующим прейскурантом. Обновите страницу и повторите приём.",
  "details": { "mismatches": [{ "code": "PRICE-1", "expectedMinor": 45000, "gotMinor": 90000 }] }
}
```

Нетиповые работы (`isCustom: true`) проверке не подлежат — их цену назначает сотрудник.
Металл распознаётся из свободного текста («Серебро 925», «Ag925»); если распознать не
удалось, применяется цена по умолчанию, и интерфейс обязан предупредить приёмщика.

## 11. Гарантия и рекламации

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/orders/:id/warranty` | Оформить гарантийный заказ |
| GET | `/orders/:id/claims` | Рекламации по заказу |
| POST | `/orders/:id/claims` | Открыть рекламацию |
| PATCH | `/claims/:id` | Обновить (взять в работу, решение) |
| POST | `/claims/:id/resolve` | Закрыть с решением |
| GET | `/claims` | Реестр рекламаций с контролем срока |

## 12. Отчёты

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| GET | `/reports/deadlines` | Сроки по этапам | MANAGER, ADMIN, PRODUCTION_MANAGER |
| GET | `/reports/production-load` | Загрузка производства | MANAGER, ADMIN, PRODUCTION_MANAGER |
| GET | `/reports/overdue` | Просрочки | MANAGER, ADMIN |
| GET | `/reports/revenue` | Выручка | MANAGER, ADMIN, CASHIER |
| GET | `/reports/prepayments` | Предоплаты | MANAGER, ADMIN, CASHIER |
| GET | `/reports/export` | Экспорт в XLSX/CSV | по правам отчёта |
| GET | `/dashboard/summary` | Сводка для главного экрана | все |

Все отчёты принимают `from`, `to`, `storeId[]`, `groupBy` и возвращают готовые агрегаты
(без вычислений на клиенте).

## 13. Администрирование

| Метод | Путь | Описание | Роли |
|-------|------|----------|------|
| GET | `/users` | Список учётных записей (фильтры `q`, `isActive`, `role`) | ADMIN |
| POST | `/users` | Создать учётную запись с ролями | ADMIN |
| GET | `/users/roles-catalog` | Справочник ролей с правами и областей видимости | ADMIN |
| GET | `/users/:id` | Карточка с вычисленными правами | ADMIN |
| PATCH | `/users/:id` | Изменить учётную запись | ADMIN |
| POST | `/users/:id/roles` | Назначить роль | ADMIN |
| DELETE | `/users/:id/roles/:roleId` | Снять роль | ADMIN |
| POST | `/users/:id/reset-password` | Сброс пароля | ADMIN |
| GET/POST/PATCH | `/stores`, `/stores/:id` | Магазины | ADMIN |
| GET/POST/PATCH | `/workshops`, `/workshops/:id` | Цеха | ADMIN |
| GET/POST/PATCH | `/stage-norms` | Нормативы этапов | ADMIN |
| GET/POST/PATCH | `/working-calendar` | Рабочий календарь | ADMIN |
| GET | `/audit` | **Журнал действий** с фильтрами | ADMIN, AUDITOR, MANAGER |
| GET | `/audit/:entity/:entityId` | История конкретной сущности | ADMIN, AUDITOR |
| GET/PATCH | `/settings` | Настройки системы | ADMIN |
| GET | `/integrations/1c/queue` | Очередь обмена с 1С | ADMIN |
| POST | `/integrations/1c/retry/:id` | Повторить отправку | ADMIN |

### Управление учётными записями: поведение

Реализовано в задаче 1.2.4 (модуль `apps/api/src/modules/users`).

* **Пароли не отдаются наружу никогда.** Поле `passwordHash` не выбирается из
  базы, поэтому утечь в ответ не может по построению; в журнал аудита пароль и
  его хеш также не попадают.
* **`mustChangePassword`.** При создании учётной записи и при сбросе пароля
  флаг выставляется в `true`. Он возвращается в `POST /auth/login` и
  `GET /auth/me`, а `POST /auth/change-password` его снимает. Пароль при
  создании задаёт администратор, поэтому система требует заменить его на
  известный только владельцу.
* **Смена прав завершает сессии.** Отключение учётной записи
  (`PATCH /users/:id` с `isActive: false`), снятие роли и сброс пароля отзывают
  все активные сессии пользователя: иначе отключённый сотрудник продолжал бы
  работать в уже открытой вкладке до истечения refresh-токена (30 дней).
* **Снятие последней роли запрещено** (код `LAST_ROLE`). Учётная запись без
  ролей не может войти в систему, поэтому её нужно именно отключить, а не
  оставить «рабочей» без ролей.
* **Администратор не блокирует сам себя:** отключение собственной учётной
  записи и снятие своей основной роли отклоняются.
* **Роль, ограниченная магазином, требует магазин.** Для `RECEIVER` и `CASHIER`
  поле `storeId` обязательно: без него область видимости не построить.
* **Чужая роль по прямому `id` — 404, не 403:** иначе по коду ответа можно было
  бы узнать о существовании роли у другой учётной записи.
* **Коды ошибок:** `EMAIL_TAKEN`, `ROLE_ALREADY_ASSIGNED`, `LAST_ROLE`,
  `NOT_FOUND`, `VALIDATION_ERROR`.

## 14. Уведомления

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/notifications` | Мои уведомления |
| PATCH | `/notifications/:id/read` | Отметить прочитанным |
| POST | `/notifications/read-all` | Прочитать все |
| GET | `/notifications/unread-count` | Счётчик для колокольчика |

## 15. Публичные эндпоинты (без аутентификации)

| Метод | Путь | Описание | Ограничения |
|-------|------|----------|-------------|
| POST | `/public/order-status/request-code` | Запросить код по номеру заказа | 3 запроса/час на телефон |
| GET | `/public/order-status` | Статус по номеру + коду | Код живёт 10 мин; минимум данных |
| GET | `/health/live`, `/health/ready` | Проверка живости | Внутренняя сеть |

## 16. Коды ошибок (контрактные)

| HTTP | Код | Когда |
|------|-----|-------|
| 400 | `VALIDATION_ERROR` | Не прошла Zod-схема |
| 401 | `UNAUTHENTICATED` | Нет/просрочен access-токен |
| 403 | `FORBIDDEN_ROLE` | Роль не имеет права |
| 403 | `FORBIDDEN_SCOPE` | Объект вне области видимости |
| 404 | `NOT_FOUND` | Объект не существует **или** вне scope (не раскрываем существование) |
| 409 | `INVALID_TRANSITION` | Переход не разрешён таблицей |
| 409 | `PREPAYMENT_REQUIRED` | Старт работ без предоплаты |
| 409 | `NOT_PAID_IN_FULL` | Выдача без полной оплаты |
| 409 | `APPROVAL_MISSING` | Нет согласования клиента |
| 409 | `CONSENT_REQUIRED` | Нет согласия на запись разговоров |
| 409 | `STALE_VERSION` | Оптимистичная блокировка |
| 409 | `IDEMPOTENCY_CONFLICT` | Тот же ключ, другие данные |
| 422 | `BUSINESS_RULE_VIOLATION` | Прочие доменные правила |
| 429 | `RATE_LIMITED` | Превышен лимит |
| 503 | `INTEGRATION_UNAVAILABLE` | Внешняя система недоступна (не блокирует приём платежа) |