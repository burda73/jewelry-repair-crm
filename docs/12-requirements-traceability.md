# 12. Трассировка требований ТЗ → реализация

Таблица показывает, **где именно** каждое требование ТЗ реализовано. Нужна для приёмки:
проверяющий видит не обещание, а конкретный код, документ и тест.

| ТЗ | Требование | Документ | Код | Тест |
|----|-----------|----------|-----|------|
| 2.1 | Регистрация заказа в любом магазине | `docs/02` §5 | `orders.service.ts` → `create()` | приёмка этапа 1 |
| 2.1 | Доступ ко всем заказам из любой точки | `docs/01` §1 | PWA, `apps/web` | — |
| 2.1 | Поиск по номеру, ФИО, телефону, статусу | `docs/07` §3 | `orders.service.ts` → `searchGlobal()`, `findAll()` | `normalizePhone` тесты |
| 2.1 | Карточка заказа с историей и платежами | `docs/08` §3 | `orders.service.ts` → `findOne()`, `getTimeline()` | — |
| 2.2 | Версионность прейскуранта | `docs/03` §3.3 | `PriceListVersion`, `OrderWork.unitPriceMinor` | схема Prisma |
| 2.2 | Цена на момент приёма сохраняется | `docs/03` §3.3 | `orders.service.ts` → `priceFixedAt`, `unitPriceMinor` | — |
| 2.2 | Утверждение руководителем | `docs/07` §10 | `POST /price-lists/:id/approve`, роль MANAGER | матрица прав |
| 2.2 | **Цена зависит от металла изделия** (золото/серебро) | `docs/03` §3.3.1, ADR 0009 | `PriceListItemRate`, `resolveItemPrice()` | `price-list-spec.spec.ts`, `price-by-metal.spec.ts` |
| 2.2 | Цена «от» и отдельный расчёт металла | `docs/03` §3.3.1 | `priceFrom`, `metalCostSeparate` | `price-list-spec.spec.ts` (14 проверок) |
| 2.2 | Сервер проверяет цену работы | `docs/07` §9.1 | `orders.service.ts` → `verifyWorkPrices()` | 409 `PRICE_MISMATCH` |
| 2.2 | Прейскурант заказчика загружен без искажений | `docs/reference/` | `price-list-spec.ts` (24 позиции) | сверка с `.docx` |
| 2.3 | Отдельные строки: работа + камни | `docs/03` §2 | `OrderWork`, `OrderStone` | — |
| 2.3 | Расходники включены в работу | `docs/03` §3.3 | `PriceListItem.priceMinor` включает расходники | — |
| 2.3 | Корректировка с фиксацией причины | `docs/03` §3.4 | `CalcAdjustment.reason` (обязательное) | валидация Zod |
| 2.3 | Сумма меняется только через корректировку | `docs/07` §5 | `POST /orders/:id/adjustments`, `applyAdjustment()` | сквозной прогон API |
| 2.3 | Уменьшение ниже внесённого запрещено | `docs/03` §3.4 | `409 ADJUSTMENT_BELOW_PAID` | прогон API (предоплата 300 из 450) |
| 2.3 | Инвариант итога держится при надбавке | `docs/03` §3.2 | `discountForTotal`, `calcOrderTotal` | 5 тестов в `money-dates.spec.ts` |
| 2.4 | Фиксация устного согласия | `docs/03` §3.5 | `Approval.isVerbal`, `channel = PHONE_VERBAL` | `approvalSchema` |
| 2.4 | Дата/время, сотрудник, сумма, срок | `docs/03` §3.5 | `Approval.createdById`, `amountMinor`, `termDays`, `approvedAt` | — |
| 2.4 | Пометка «согласовано устно» | `docs/08` §3 | `Approval.isVerbal` → бейдж в UI | `docs-sync.spec.ts` |
| 2.4 | Переход открывается только после согласования | `docs/03` §3.5 | guard `APPROVAL_EXISTS` считает только `APPROVED` | прогон API: до согласования 409 |
| 2.4 | `isVerbal` нельзя подделать | `docs/07` §6 | сервер выводит из `channel` | прогон API: `SMS` + флаг → `false` |
| 2.4 | Срок считается по рабочему календарю | `docs/07` §6 | `addWorkingDays`, `promisedAt` | прогон API: срок не на выходной |
| 2.7 | Праздники ТК РФ нерабочие | `docs/00` §10 | `isStateHoliday()`, приоритет «исключение → праздник → день недели» | `working-calendar.spec.ts` (15 тестов), `docs/07` §10.2 |
| 2.7 | Срок не попадает на каникулы | `docs/00` §10 | `addWorkingDays(2026-12-25, 5)` → `2027-01-11` | `working-calendar.spec.ts`; 3 теста падают без исправления |
| 2.7 | Календарь правится без разработчика | `docs/07` §10.2 | `GET/POST/PATCH/DELETE /working-calendar`, экран администратора | `working-calendar.service.spec.ts` (33 теста) |
| 2.7 | Зеркальные записи не возвращаются | `docs/07` §10.2 | `CALENDAR_REDUNDANT_DAY`, миграция `20260919000000` | `working-calendar.service.spec.ts`: 4 теста падают без защиты |
| 2.4 | Согласование суммы создаёт корректировку | `docs/03` §3.5 | `applyAdjustment()` из `createApproval()` | прогон API: 450→400, скидка 50 |
| 2.4 | **Интеграция с IP-АТС** | `docs/05` §2 | `CallRecording`, `TelephonyPort`, скоринг сопоставления | этап 4 |
| 2.4 | Обязательный пункт о записи разговоров | `docs/02` §5.6 | guard `CONSENT_CALL_RECORDING`, `Customer.consentCallRecording` | `order-transitions.spec.ts` |
| 2.4 | Срок хранения записей — 1 год | `docs/05` §2.5 | `CallRecording.retainUntil`, воркер retention | этап 4 |
| 2.5 | Приём в любом магазине по номеру | `docs/03` §3.7 | `Payment.storeId`, глобальный поиск | `order-transitions.spec.ts` |
| 2.5 | Привязка платежа независимо от места | `docs/03` §3.7 | `Payment.storeId` + `orderId` | — |
| 2.5 | Синхронизация с 1С | `docs/05` §1 | `IntegrationOutbox`, воркер | этап 3 |
| 2.5 | **Блокировка старта работ** | `docs/02` §5.1 | guard `PREPAYMENT_SATISFIED`, `isPrepaymentSatisfied()` | `money-dates.spec.ts` |
| 2.5 | Поиск заказа по отсканированному QR | `docs/08` §4.1 | `normalizeScanInput` в `@app/shared` | 5 тестов `order-number.spec.ts`, прогон API |
| 2.8 | Сканирование при выдаче | `docs/08` §4.1 | тот же поиск по номеру | прогон API |
| 2.6 | Формирование партий по графику | `docs/03` §2 | `Batch`, `BatchItem`, `plannedAt` | этап 2 |
| 2.6 | Акт приёма-передачи (электронный) | `docs/03` §2 | `BatchAct`, `itemsSnapshot` | этап 2 |
| 2.6 | Фотофиксация партии | `docs/03` §2 | `BatchPhoto`, `FileObject` | этап 2 |
| 2.6 | Отслеживание статуса «в пути» | `docs/04` §1 | `IN_TRANSIT_TO_PRODUCTION`, `IN_TRANSIT_TO_STORE` | `order-transitions.spec.ts` |
| 2.7 | Нормативы по каждому этапу | `docs/04` §3 | `StageNorm` (версионируемый справочник) | — |
| 2.7 | Автоуведомления при просрочке | `docs/04` §4 | воркер escalations, `Notification` | этап 2 |
| 2.7 | Уведомление руководителю при >1 дня | `docs/04` §4 | `isOverdueForManager()` | `money-dates.spec.ts` |
| 2.7 | Дашборд просроченных заказов | `docs/06` §3 | `GET /orders/overdue`, индекс `(status, dueAt)` | — |
| 2.8 | Фиксация оплаты, синхронизация с 1С | `docs/05` §1 | `Payment`, `IntegrationOutbox` | этап 3 |
| 2.8 | **Условие выдачи — полная оплата** | `docs/02` §5.2 | guard `PAID_IN_FULL`, `isPaidInFull()` | `money-dates.spec.ts` |
| 2.8 | Акт отказа при отказе от оплаты | `docs/03` §2 | `RefusalAct`, guard `REFUSAL_ACT_EXISTS` | `order-transitions.spec.ts` |
| 2.8 | Статус «невостребовано» через 30 дней | `docs/02` §5.3 | guard `UNCLAIMED_THRESHOLD`, `addCalendarDays()` | `money-dates.spec.ts` |
| 2.9 | Признак гарантийного заказа | `docs/03` §2 | `Order.isWarranty`, `parentOrderId` | — |
| 2.9 | Срок гарантии 6 мес. / 3 мес. (закрепка) | `docs/02` §5.4 | `computeWarrantyUntil()`, `warrantyMonths` | `money-dates.spec.ts` |
| 2.9 | Срок рассмотрения рекламации 10 раб. дней | `docs/02` §5.5 | `WarrantyClaim.dueAt`, `addWorkingDays()` | `money-dates.spec.ts` |
| 2.9 | Запись рекламации в основном заказе | `docs/03` §2 | `WarrantyClaim.orderId` → `Order.claims` | — |
| 2.10 | Роли и права доступа | `docs/02` §2, §4 | `packages/shared/src/domain/roles.ts` | `docs-sync.spec.ts` |
| 2.11 | Отчёт «Сроки по этапам» | `docs/06` §1 | `OrderStatusHistory.durationMinutes` | этап 5 |
| 2.11 | Отчёт «Загрузка производства» | `docs/06` §2 | `OrderAssignment`, `durationHours` | этап 5 |
| 2.11 | Отчёт «Просрочки» | `docs/06` §3 | `dueAt`, `escalatedAt` | этап 5 |
| 2.11 | Отчёт «Выручка» | `docs/06` §4 | `Payment` по `paidAt` | этап 5 |
| 2.11 | Отчёт «Предоплаты» | `docs/06` §5 | `Payment.kind = PREPAYMENT` | этап 5 |
| 3 | Интеграция с 1С | `docs/05` §1 | `AccountingPort`, outbox | этап 3 |
| 3 | Интеграция с IP-АТС | `docs/05` §2 | `TelephonyPort` | этап 4 |
| 3 | СМС/мессенджеры (опционально) | `docs/05` §3 | `NotificationPort`, `NotificationTemplate` | этап 5 |
| 4 | Ролевая модель доступа | `docs/02` §4 | `RolesGuard`, `ScopeGuard` | `docs-sync.spec.ts` |
| 4 | Журнал действий пользователей | `docs/10` §4 | `AuditLog` (append-only) | миграция + права БД |
| 4 | Резервное копирование **файлов** (фото, записи, PDF) | `docs/10` §5.2 | `infra/backup/backup.sh` (файлы + конфигурация) | `restore-drill.sh` |
| 4 | Резервное копирование **БД** | `docs/10` §5.1 | **Внешний PostgreSQL**: система копирования настроена на отдельном сервере БД; выполняет администратор | уточнить проверку восстановлением (задача 0.9) |
| 4 | **RPO ≤ 5 минут** для БД | `docs/10` §2, §5.1 | Достигается только **PITR** (непрерывная архивация WAL) | **Требует подтверждения**: при периодических дампах фиксируется как принятое отклонение с фактическим значением |
| 4 | Разграничение прав по магазинам | `docs/02` §3 | `buildOrderScopeFilter()`, `STORE_PLUS_GLOBAL_SEARCH` | приёмка этапа 1 |
| 4 | **Управление пользователями и ролями** | `docs/07` §13 | `users.service.ts`, `users.controller.ts` (8 маршрутов) | 24 теста `users.service.spec.ts`; прогон API |
| 4 | Назначение и снятие ролей с магазином | `docs/07` §13 | `assignRole()`, `revokeRole()`, `user_role.grantedById` | прогон API: назначение, повтор → 409, снятие последней → `LAST_ROLE` |
| 4 | Пароль задаёт администратор, смена обязательна | `docs/07` §13 | `mustChangePassword` в `AuthenticatedUser` и в токене | прогон API: вход → `true`, смена пароля → `false` |
| 4 | Отключение учётной записи закрывает доступ | `docs/07` §13 | `revokeSessions` в `update()`, `revokeRole()`, `resetPassword()` | тесты на отзыв сессий; прогон API |
| 4 | Учётная запись без ролей не может войти | `docs/02` §3 | `buildAuthenticatedUser()` → `NO_ROLES_ASSIGNED`; `LAST_ROLE` | 2 теста на запрет снятия последней роли |
| 4 | **Администрирование справочников** (магазины, цеха, исполнители, категории работ, камни) | `docs/07` §10.1, ТЗ п. 4 | `dictionaries-admin.service.ts`, `dictionaries-admin.controller.ts` (10 маршрутов) | 24 теста `dictionaries-admin.service.spec.ts`; прогон API: создание, дубликат → `CODE_TAKEN` |
| 4 | Справочники не удаляются, а отключаются (`isActive`) | `docs/03` §1, `docs/07` §10.1 | `DictionariesAdminService`, маршрута `DELETE` нет | 24 теста; проверка, что двойник Prisma без `delete` не вызывается |
| 4 | Код магазина входит в номер заказа и неизменяем при наличии заказов | `docs/03` §1 | `updateStore()` → `STORE_CODE_IN_USE` | тест на запрет смены кода + прогон API на `MSK1` (1 заказ) |
| 4 | Нельзя остановить приём: последний магазин не отключается | `docs/07` §10.1 | `assertStoreCanBeDeactivated()` → `LAST_ACTIVE_STORE` | тесты на `LAST_ACTIVE_STORE`, `STORE_HAS_ACTIVE_USERS` |
| 4 | Цех не отключается с исполнителями или незавершёнными заказами | `docs/07` §10.1 | `updateWorkshop()` → `WORKSHOP_HAS_ACTIVE_PERFORMERS`, `WORKSHOP_HAS_OPEN_ORDERS` | тесты + проверка, что терминальные статусы не считаются препятствием |
| 4 | Исполнитель ведётся менеджером производства, справочники — администратором | `docs/02` §4 | `@RequirePermission`: `PERFORMER_MANAGE` / `SETTINGS_MANAGE` | прогон API: приёмщик → `403` на всех маршрутах; менеджер → исполнители `201`, магазин `403` |
| 4 | Изменения справочников попадают в журнал аудита | `docs/10` §4 | `DictionariesAdminService.audit()` внутри `$transaction` | тесты на `before`/`after`; прогон: `CREATE` → `before: null` |
| 4 | Пароли не хранятся и не логируются в открытом виде | `docs/10` §3 | Argon2id; `passwordHash` не выбирается из БД | тест: пароля нет в ответе и в аудите |
| 4 | Веб-интерфейс | `docs/01` §1 | Next.js PWA | — |
| 4 | Мобильная адаптация | `docs/08` §5 | PWA, раскладки от 360 px | юзабилити-тест |
| 5 | Этапы внедрения | `docs/09` §2–§9 | совпадают с ТЗ п. 5 | — |

## Требования, изменённые относительно ТЗ

| ТЗ | Было | Стало | Почему |
|----|------|-------|--------|
| 2.10 | Роль «Мастер-ювелир» в списке пользователей | Роль исключена; исполнитель — запись справочника `Performer` | Решение заказчика: ювелиру доступ не нужен |
| 2.10 | 6 ролей, включая «Мастер-ювелира» | 8 ролей: мастер исключён (−1), добавлены `CASHIER`, `AUDITOR`, `CHIEF_ACCOUNTANT` (+3) | ТЗ п. 2.5/2.8 и п. 4 требуют отдельных прав; главбух соутверждает прейскурант (ответ A2) |
| 2.7 | Нормативы сроков «по факту» | Стартовые значения + настройка без разработчика | Утверждённых нормативов у заказчика нет (ответ A3) |
| 2.7 | Журнал аудита неизменяем | `docs/03` §3.6 | триггер `audit_log_append_only`, миграция `20260918000000` | прогон SQL: UPDATE/DELETE/TRUNCATE заблокированы |
| 2.7 | Очистка тестовых данных перед продакшном | `README.md` «Переключение в продакшн» | `scripts/purge-test-data.mjs` | прогон на копии БД: план, `--apply`, `--files`, `--users` |
| 3 | Интеграция с 1С: полный обмен | Только фиксация оплаты через `ЧекККМ` | Ответ A4: в 1С достаточно фиксировать факт оплаты |
| 2.1 | Поиск по номеру заказа | + Считывание QR-кода с квитанции сканером | Новое требование, ответ A4 |
| 2.1 | Квитанция с QR-кодом при приёме | `docs/08` §4.1 | `GET /orders/:id/receipt`, `ReceiptService`, `buildOrderQrPayload` | 5 тестов `receipt.service.spec.ts`, 17 тестов `receipt.spec.ts` |
| 2.1 | Учёт перепечаток квитанции | `docs/08` §4.1 | `receiptPrintCount`, `receiptLastPrintedAt`, аудит `RECEIPT_PRINT` | прогон API и браузера |
| 2.1 | QR читается сканером | `docs/08` §4.1 | белый фон кодов, `parseOrderNoFromScan` | декодирование QR из готового PDF |
| 2.1 | Кириллица в PDF | `docs/08` §4.1 | встроенный DejaVu Sans (`dejavu-fonts-ttf`) | тест на наличие шрифта; извлечённый текст квитанции |
| 2.1 | Фото фиксируются при приёме, привязаны к изделию | `docs/07` §6.2 | `ItemPhoto`, `PhotosService`, `StorageService` | 13 тестов `storage.service.spec.ts` |
| 2.1 | Ключ хранилища не выходит наружу | `docs/07` §6.2 | ответ API отдаёт `url`/`thumbnailUrl` | прогон API и браузера |
| 2.1 | Фото чужого магазина недоступны | `docs/07` §6.2 | область видимости по заказу | прогон: MSK2 → 404, аноним → 401 |
| 2.1 | Защита от чтения произвольного файла | `docs/07` §6.2 | `assertSafeKey`, проверка пути | 4 теста на `../`, абсолютный путь |
| 4 | «Мобильная адаптация» | PWA вместо нативного приложения | Решение заказчика |
| 4 | Резервное копирование БД нашим скриптом | Копирование выполняет администратор БД | Ответ A1: PostgreSQL внешний, общий с 1С; копирование уже настроено на отдельном сервере |

**Возможное отклонение (ждёт подтверждения):** требование «RPO ≤ 5 минут» выполнимо
только при непрерывной архивации WAL (PITR). Если существующая система копирования делает
только периодические дампы, фактический RPO равен интервалу между ними. Тогда требование
помечается здесь как принятое отклонение с указанием фактического значения, а не как
выполненное (`infra/db/README.md` §5.2).

Подробности — `docs/00-decisions.md` §1–§2 и `docs/11-open-questions.md` раздел G.