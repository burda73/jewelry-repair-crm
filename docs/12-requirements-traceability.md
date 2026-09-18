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
| 2.7 | **Норматив срока применяется при переходе** | `docs/04` §3 | `stageForStatus()` + `pickStageNorm()` + `computeDueAt()` | `order-workflow.service.spec.ts` (19 тестов); реальный переход проставил `dueAt` на живом API (до исправления — 0 из 13) |
| 2.7 | Нормативы настраиваются администратором | `docs/07` §10.3 | `GET/POST /stage-norms/versions`, экран администратора | `stage-norms.service.spec.ts` (18 тестов), `stage-norms.spec.ts` (15) |
| 2.7 | Единица нормативa соблюдается | `docs/04` §3 | `WORKDAY` / `WORKHOUR` / `CALENDAR_DAY` в `computeDueAt()` | `order-workflow.service.spec.ts`: 8 тестов единиц измерения |
| 2.7 | Неизвестная единица не даёт срока | `docs/04` §3 | `computeDueAt()` возвращает `null` | тест падает без защиты: «похожее» значение обещало бы неверную дату |
| 2.7 | Словарь этапов един | `docs/15` «Дефект 26» | `NORM_STAGE` + `ALL_NORM_STAGES` в домене, миграция `20260920000000` | `stage-norms.spec.ts`: тесты на недостижимые и чужие этапы |
| 2.7 | Каждый переход с `SET_DUE_AT` имеет норматив | `docs/04` §2 | инвариант «статус → этап → норматив» | `order-workflow.service.spec.ts`: 2 теста падают, если вернуть `SET_DUE_AT` переходу в `ACCEPTED` |
| 2.7 | Документация эффектов не расходится с кодом | `docs/04` §2 | сверка `SET_DUE_AT` ↔ `dueAt` в таблице переходов | `docs-sync.spec.ts`: падает с перечнем расхождений |
| — | PWA устанавливается на домашний экран | `docs/08` §5.1 | манифест, иконки 192/512/180, `apple-touch-icon` | `service-worker.spec.ts`: файлы манифеста существуют и непусты |
| — | Приложение открывается при кратком пропадании сети | `docs/08` §5.1 | Service Worker, кэш статики сборки | тесты перехвата статики |
| — | Данные клиента и денег не застревают на устройстве | `docs/08` §5.1 | API и HTML страниц не кэшируются; очистка кэша при выходе | тест падает, если страницы начнут отдаваться из кэша |
| — | Срез списка заказов сохраняется и передаётся ссылкой | `docs/08` §4.2 | `useSavedViews`, фильтры в адресе (`filtersToQuery`/`queryToFilters`) | `saved-views.spec.ts` (31 тест) |
| — | Представления одного сотрудника не видны другому | `docs/08` §4.2 | ключ с `userId`; очистка при выходе | тест падает, если убрать `userId` из ключа |
| — | Недоверенный срез не уходит в запрос к API | `docs/08` §4.2 | `normalizeFilters` для хранилища и для адреса | тесты на неизвестные поля и неверные типы |
| — | Черновик мастера не теряется при отвлечении | `docs/08` §4.1 | `useDraftAutosave`, `localStorage` | `draft-autosave.spec.ts` (20 тестов) |
| — | Черновик одного сотрудника не виден другому | `docs/08` §4.1 | ключ с `userId`; очистка при выходе (`clearAllDraftsForUser`) | 2 теста падают, если убрать `userId` из ключа |
| — | Устаревший черновик не восстанавливается | `docs/08` §4.1 | срок годности 7 дней, версия схемы | тест падает, если снять проверку срока |
| 2.4 | Согласование суммы создаёт корректировку | `docs/03` §3.5 | `applyAdjustment()` из `createApproval()` | прогон API: 450→400, скидка 50 |
| 2.4 | **Интеграция с IP-АТС** | `docs/05` §2 | `CallRecording`; контракт `TelephonyPort` — `docs/05` §6.2; требования к заказчику — `docs/05` §2.7 | этап 4 (отложен заказчиком); документация и контракт готовы |
| 2.4 | Обязательный пункт о записи разговоров | `docs/02` §5.6 | guard `CONSENT_CALL_RECORDING`, `Customer.consentCallRecording` | `order-transitions.spec.ts` |
| 2.4 | Срок хранения записей — 1 год | `docs/05` §2.5 | `CallRecording.retainUntil`, воркер retention | этап 4 |
| 2.5 | Приём в любом магазине по номеру | `docs/03` §3.7 | `Payment.storeId`, глобальный поиск | `order-transitions.spec.ts` |
| 2.5 | Привязка платежа независимо от места | `docs/03` §3.7 | `Payment.storeId` + `orderId` | — |
| 2.5 | Синхронизация с 1С | `docs/05` §1 | `IntegrationOutbox`; контракт `AccountingPort` — `docs/05` §6.1; требования к подрядчику — `docs/05` §1.3.1 | этап 3 (отложен заказчиком); документация и контракт готовы |
| 2.5 | **Блокировка старта работ** | `docs/02` §5.1 | guard `PREPAYMENT_SATISFIED`, `isPrepaymentSatisfied()` | `money-dates.spec.ts` |
| 2.5 | Поиск заказа по отсканированному QR | `docs/08` §4.1 | `normalizeScanInput` в `@app/shared` | 5 тестов `order-number.spec.ts`, прогон API |
| 2.8 | Сканирование при выдаче | `docs/08` §4.1 | тот же поиск по номеру | прогон API |
| 2.6 | Формирование партий по графику | `docs/07` §8.7, `docs/03` §2 | `batches.service.ts` → `create()`, `Counter` `BATCH:ГГГГММДД` | `batches.service.spec.ts` (номер = плановая дата) |
| 2.6 | Состав партии: правила включения | `docs/07` §8.1 | `@app/shared` → `checkBatchEligibility()` | `batches.spec.ts` (17 тестов), `batches.service.spec.ts` |
| 2.6 | Лимит состава партии | `docs/07` §8.7 | `Setting.logistics.batchMaxItems`, `exceedsBatchLimit()` | `batches.service.spec.ts` (лимит выключен по умолчанию) |
| 2.6 | Заказ не может ехать в двух партиях | `docs/07` §8.1 | `batches.service.ts` → `ordersInActiveBatches()` | `batches.service.spec.ts` (проверка до записи) |
| 2.6 | Акт приёма-передачи (электронный) | `docs/07` §8.2, `docs/03` §2 | `batches.service.ts` → `formAct()` | `batches.service.spec.ts` (8 тестов), `batches.spec.ts` |
| 2.6 | Снимок состава фиксируется при формировании акта | `docs/07` §8.2 | `buildBatchActSnapshot()` | `batches.spec.ts` (6 тестов: сортировка, сумма, копия) |
| 2.6 | Состав заморожен после акта | `docs/07` §8.2 | `batchCompositionLockReason()` | `batches.service.spec.ts` (4 теста заморозки) |
| 2.6 | PDF акта приёма-передачи | `docs/07` §8.3 | `batch-act-pdf.service.ts` | `batch-act-pdf.service.spec.ts` (13 тестов, текст из PDF) |
| 2.6 | Кириллица в PDF (встроенный шрифт) | `docs/07` §8.3 | `dejavu-fonts-ttf` в `require.resolve` | `batch-act-pdf.service.spec.ts` (падает при системном шрифте) |
| 2.6 | Подпись обеих сторон | `docs/07` §8.3 | `batches.service.ts` → `signAct()` | `batches.service.spec.ts` (9 тестов подписи) |
| 2.6 | Сохранённая копия акта | `docs/07` §8.3 | `batches.service.ts` → `storeActPdf()`, `Document` | `batches.service.spec.ts` (2 теста) |
| 2.6 | Фотофиксация партии | `docs/07` §8.6 | `batches.service.ts` → `uploadPhotos()` | `batches.service.spec.ts` (14 тестов) |
| 2.6 | Отправка партии: массовый перевод в «в пути» | `docs/07` §8.4 | `batches.service.ts` → `dispatch()` | `batches.service.spec.ts` (14 тестов) |
| 2.6 | Приём партии: массовый перевод в производство | `docs/07` §8.4 | `batches.service.ts` → `receive()` | `batches.service.spec.ts` |
| 2.6 | Перевод всех заказов в ОДНОЙ транзакции | `docs/07` §8.4 | `order-workflow.service.ts` → `ctx.tx` | `batches.service.spec.ts` (падает при собственной транзакции) |
| 2.6 | Ветки направлений не пересекаются | `docs/07` §8.4 | `batchOrderTargetStatus()` | `batches.spec.ts` (4 разных статуса) |
| 2.6 | Роль проверяется таблицей переходов | `docs/07` §8.4 | `OrderWorkflowService.transition()` | прогон API: логист получает 403 при приёмке цехом |
| 2.6 | Массовая операция повторяема | `docs/07` §8.4 | пропуск заказа в целевом статусе | `batches.service.spec.ts` |
| 2.6 | Отслеживание «в пути»: состояние считается на чтение | `docs/07` §8.5 | `@app/shared` → `assessTransit()` | `tracking.spec.ts` (15 тестов) |
| 2.6 | Уровни тревоги вместо флага «просрочено» | `docs/07` §8.5 | `TRANSIT_LEVEL`, границы норматива | `tracking.spec.ts` (падает при сдвиге границы) |
| 2.6 | Норматив доставки из настройки | `docs/07` §8.5 | `Setting.logistics.transitNormHours` | `batches.service.spec.ts` |
| 2.6 | Бессмысленный норматив → значение по умолчанию | `docs/07` §8.5 | `assessTransit()` | `tracking.spec.ts` (ноль, отрицательное, NaN, Infinity) |
| 2.6 | Задержанные партии сверху | `docs/07` §8.5 | `batches.service.ts` → `listInTransit()` | `batches.service.spec.ts` (падает без сортировки) |
| 2.6 | Список «в пути» только для партий в пути и в scope | `docs/07` §8.5 | `BATCH_STATUS.IN_TRANSIT` + `buildScopeFilter()` | `batches.service.spec.ts` |
| 2.6 | Лента уведомлений | `docs/07` §14 | `notifications.service.ts` → `listMine()` | `notifications.service.spec.ts` (18 тестов) |
| 2.6 | Чужое уведомление не читается | `docs/07` §14 | фильтр по `userId`, 404 вместо 403 | `notifications.service.spec.ts` |
| 2.6 | Уведомление создаётся как PENDING (очередь отправки) | `docs/07` §14 | `notifyByTemplate()` | `notifications.service.spec.ts` |
| 2.6 | Отсутствие шаблона не отменяет операцию | `docs/07` §14 | запасной текст в `notifyByTemplate()` | `notifications.service.spec.ts` |
| 2.6 | Уведомление о приёмке отправителю рейса | `docs/07` §14 | `batches.service.ts` → `notifyBatchReceived()` | `batches.service.spec.ts` |
| 2.6 | Сбой уведомления не отменяет приёмку | `docs/07` §14 | `.catch(() => undefined)` после транзакции | `batches.service.spec.ts` |
| 2.8 | Эскалация просрочки: уровни и пороги | `docs/04` §4, `docs/07` §13.1 | `@app/shared` → `assessEscalation()` | `escalation.spec.ts` (20 тестов) |
| 2.8 | Порог руководителя — рабочий день (9 раб. часов) | `docs/04` §4 | `MANAGER_ESCALATION_HOURS` | `escalation.spec.ts` (падает при сдвиге порога) |
| 2.8 | Просрочка считается в РАБОЧИХ часах | `docs/04` §4 | `countWorkingHours()` | `escalation.spec.ts` (падает при календарном счёте) |
| 2.8 | Согласованность подсчёта и расчёта сроков | `docs/04` §4 | сверка с `addWorkingHours()` | `escalation.spec.ts` (сверка на 7 значениях) |
| 2.8 | Адресат зависит от этапа | `docs/04` §5 | `escalations.service.ts` → `resolveRecipients()` | `escalations.service.spec.ts` (20 тестов) |
| 2.8 | Уровень не повышается без рассылки | `docs/07` §13.1 | проверка `created === 0` | `escalations.service.spec.ts` |
| 2.8 | Повторная эскалация того же уровня молчит | `docs/07` §13.1 | `shouldEscalateAgain()` | `escalation.spec.ts`, `escalations.service.spec.ts` |
| 2.8 | Руководителю — отдельный шаблон | `docs/07` §13.1 | `TEMPLATE_CODE.ESCALATION_MANAGER` | `escalations.service.spec.ts` |
| 2.8 | В письме руководителю — имя ответственного (дефект 32) | `docs/15` | `productionManager.fullName`, `createdBy.fullName` | `escalations.service.spec.ts` (падает при подстановке номера заказа) |
| 2.8 | Сбой на одном заказе не отменяет остальные | `docs/07` §13.1 | `try/catch` внутри цикла | `escalations.service.spec.ts` |
| 2.8 | Норматив в рабочих часах не истекает раньше срока (дефект 31) | `docs/15` | `addWorkingHours()` | `money-dates.spec.ts` (6 тестов, падают при возврате) |
| 2.9 | Дашборд просрочек: сводка, разрезы, список | `docs/07` §13.1.1 | `overdue-dashboard.service.ts` → `build()` | `overdue-dashboard.service.spec.ts` (11 тестов) |
| 2.9 | Просрочка считается по `dueAt`, не по факту уведомления | `docs/07` §13.1.1 | запрос без условия по `escalatedAt` | `overdue-dashboard.service.spec.ts` |
| 2.9 | Набор заказов совпадает с воркером эскалаций | `docs/07` §13.1.1 | `EXCLUDED_STATUSES` | `overdue-dashboard.service.spec.ts` |
| 2.9 | Самые задержанные сверху, разрезы по числу | `docs/07` §13.1.1 | сортировка в `build()` и `groupBy()` | `overdue-dashboard.service.spec.ts` |
| 2.10 | Автостатус «Невостребовано» через 30 дней | `docs/04` §4, `docs/07` §13.1.2 | `unclaimed.service.ts` → `run()` | `unclaimed.service.spec.ts` (11 тестов) |
| 2.10 | Перевод ЧЕРЕЗ таблицу переходов, а не UPDATE | `docs/07` §13.1.2 | `workflow.transition()` (переход 19) | `unclaimed.service.spec.ts` (падает при прямой записи) |
| 2.10 | Системный переход передаёт `actorId = null` (дефект 33) | `docs/15` | `OrderWorkflowService.transition()` → `INVALID_ACTOR` | `unclaimed.service.spec.ts`, `order-workflow.service.spec.ts` |
| 2.5–2.10 | Шаблоны уведомлений доходят до боевого сервера (дефект 34) | `docs/14`, `docs/15` | `@app/shared` → `NOTIFICATION_TEMPLATES`, `scripts/sync-templates.mjs` | `notification-templates.spec.ts` (5 тестов) |
| 2.8–2.10 | Плановые задачи запускаются на сервере | `docs/14` | `infra/systemd/repair-worker.service`, `deploy.sh` | журнал воркера, `systemctl is-active repair-worker` |
| 2.10 | Порог из настройки, бессмысленный → по умолчанию | `docs/07` §13.1.2 | `Setting.orders.unclaimedAfterDays` | `unclaimed.service.spec.ts` |
| 2.10 | Сбой на одном заказе не останавливает прогон | `docs/07` §13.1.2 | `try/catch` внутри цикла | `unclaimed.service.spec.ts` |
| 2.10 | Уведомление приёмщикам магазина | `docs/02` §5.3 | `roles.some({ role: 'RECEIVER', storeId })` | `unclaimed.service.spec.ts` |
| 2.7 | Курьер видит только назначенные на него рейсы | `docs/07` §8.4.1 | `listMyDeliveries()` → фильтр `courierId` | `batches.service.spec.ts` (падает при снятии фильтра) |
| 2.7 | Руководитель видит и нераспределённые рейсы | `docs/07` §8.4.1 | проверка `PRODUCTION_MANAGER`/`ADMIN` | `batches.service.spec.ts` |
| 2.7 | Завершённые рейсы в списке курьера отсутствуют | `docs/07` §8.4.1 | `status.notIn([RECEIVED, CANCELLED])` | `batches.service.spec.ts` |
| 2.7 | Рейсы «в пути» идут первыми, задержанные — выше | `docs/07` §8.4.1 | сортировка в `listMyDeliveries()` | `batches.service.spec.ts` |
| 2.7 | Поиск по скану: точный номер, затем номер заказа | `docs/07` §8.4.1 | `findByScan()` | `batches.service.spec.ts` |
| 2.7 | Неизвестный код даёт 404, а не пустой ответ | `docs/07` §8.4.1 | `NotFoundException(BATCH_NOT_FOUND)` | `batches.service.spec.ts` |
| 2.7 | Область видимости применяется и при поиске по скану | `docs/07` §8.4.1 | `buildScopeFilter()` в обоих запросах | `batches.service.spec.ts` |
| 2.7 | Кириллица и URI кодируются в запросе скана | `docs/07` §8.4.1 | `buildQuery()` в `findBatchByScan()` | `batch-scan.spec.ts` (4 теста, падают без кодирования) |
| 2.6 | Загружать фото можно и при приёмке | `docs/07` §8.6 | `canUploadBatchPhoto()` | `batches.spec.ts` (падает при сужении списка) |
| 2.6 | Удалять фото только до отправки | `docs/07` §8.6 | `canDeleteBatchPhoto()` | `batches.spec.ts`, `batches.service.spec.ts` (409) |
| 2.6 | Ключ хранилища не отдаётся наружу | `docs/07` §8.5 | `listPhotos()` → только `url` | `batches.service.spec.ts` (подмена на objectKey роняет тест) |
| 2.6 | Файл-призрак не остаётся на диске | `docs/07` §8.5 | `uploadPhotos()` → `storage.remove` | `batches.service.spec.ts` (снятие уборки роняет тест) |
| 2.6 | Партия переходит в `ACT_FORMED` вместе с актом | `docs/04` §1 | `batches.service.ts` → `formAct()` (одна транзакция) | `batches.service.spec.ts` |
| 2.6 | Отслеживание статуса «в пути» | `docs/04` §1 | `IN_TRANSIT_TO_PRODUCTION`, `IN_TRANSIT_TO_STORE` | `order-transitions.spec.ts` |
| 2.7 | Нормативы по каждому этапу | `docs/04` §3 | `StageNorm` (версионируемый справочник) | — |
| 2.7 | Автоуведомления при просрочке | `docs/04` §4 | воркер escalations, `Notification` | этап 2 |
| 2.7 | Уведомление руководителю при >1 дня | `docs/04` §4 | `isOverdueForManager()` | `money-dates.spec.ts` |
| 2.7 | Дашборд просроченных заказов | `docs/06` §3 | `GET /orders/overdue`, индекс `(status, dueAt)` | — |
| 2.8 | Фиксация оплаты, синхронизация с 1С | `docs/05` §1 | `Payment.idempotencyKey`/`externalId`/`syncStatus` (есть в схеме), `IntegrationOutbox` | этап 3 (отложен заказчиком) |
| 2.8 | **Условие выдачи — полная оплата** | `docs/02` §5.2 | guard `PAID_IN_FULL`, `isPaidInFull()` | `money-dates.spec.ts` |
| 2.8 | Акт отказа при отказе от оплаты | `docs/03` §2 | `RefusalAct`, guard `REFUSAL_ACT_EXISTS` | `order-transitions.spec.ts` |
| 2.8 | Статус «невостребовано» через 30 дней | `docs/02` §5.3 | guard `UNCLAIMED_THRESHOLD`, `addCalendarDays()` | `money-dates.spec.ts` |
| 2.9 | Признак гарантийного заказа | `docs/03` §2 | `Order.isWarranty`, `parentOrderId` | — |
| 2.9 | Срок гарантии 6 мес. / 3 мес. (закрепка) | `docs/02` §5.4 | `computeWarrantyUntil()`, `warrantyMonths` | `money-dates.spec.ts` |
| 2.9 | Срок рассмотрения рекламации 10 раб. дней | `docs/02` §5.5 | `WarrantyClaim.dueAt`, `addWorkingDays()` | `money-dates.spec.ts` |
| 2.9 | Запись рекламации в основном заказе | `docs/03` §2 | `WarrantyClaim.orderId` → `Order.claims` | — |
| 2.10 | Роли и права доступа | `docs/02` §2, §4 | `packages/shared/src/domain/roles.ts` | `docs-sync.spec.ts` |
| 2.11 | Отчёт «Сроки по этапам» | `docs/06` §1, `docs/07` §12.3 | `OrderStatusHistory.durationMinutes` | `reports.service.spec.ts`, `reports.spec.ts` |
| 2.11 | Перцентиль совпадает с `percentile_cont` | `docs/06` §1 | `percentile()` | `reports.spec.ts` |
| 2.11 | Переходы без длительности не занижают среднее | `docs/07` §12.3 | `durationMinutes: { not: null }` | `reports.service.spec.ts` |
| 2.11 | «Доля в норме» только по этапам с нормативом | `docs/06` §1 | `inNormShare()` | `reports.spec.ts`, `reports.service.spec.ts` |
| 2.11 | Срок ровно по нормативу — не нарушение | `docs/07` §12.3 | `durationHours > normHours` | `reports.service.spec.ts` |
| 2.11 | Отчёт «Загрузка производства» | `docs/06` §2 | `OrderAssignment.finishedAt − startedAt` | `reports.service.spec.ts` |
| 2.11 | Незавершённые назначения не дают фактических часов | `docs/06` §2 | `finishedAt !== null` | `reports.service.spec.ts` |
| 2.11 | Отчёт «Просрочки» | `docs/06` §3 | `dueAt` | `reports.service.spec.ts` |
| 2.11 | Просрочка «сейчас» исключает терминальные статусы | `docs/07` §12.3 | `TERMINAL_STATUSES` | `reports.service.spec.ts` |
| 2.11 | Просрочка «за период» их НЕ исключает | `docs/07` §12.3 | фильтр периода | `reports.service.spec.ts` |
| 2.11 | Единый формат `columns` + `rows` + `totals` | `docs/07` §12.1 | `ReportResult` | `reports.spec.ts` |
| 2.11 | Параметр `storeId` сужает доступ, не расширяет | `docs/07` §12.2 | `scopedStoreIds()` | `reports.service.spec.ts` (4 теста) |
| 2.11 | Роль без магазинов не видит ничего | `docs/07` §12.2 | `RESTRICTED_TO_NOTHING` | `reports.service.spec.ts` |
| 2.11 | Границы периода — московские сутки | `docs/07` §12.2 | `moscowDayStart()` | `reports.service.spec.ts` |
| 2.11 | Верхняя граница — конец суток | `docs/07` §12.2 | `endOfPeriod()` | `reports.service.spec.ts` |
| 2.11 | Предел периода 800 дней | `docs/07` §12.2 | `MAX_PERIOD_DAYS` | `reports.service.spec.ts` |
| 2.11 | Отчёт «Загрузка производства» | `docs/06` §2 | `OrderAssignment`, `durationHours` | этап 5 |
| 2.11 | Отчёт «Просрочки» | `docs/06` §3 | `dueAt`, `escalatedAt` | этап 5 |
| 2.11 | Отчёт «Выручка» | `docs/06` §4, `docs/07` §12.4 | `Payment` по `paidAt` | `reports.service.spec.ts` |
| 2.11 | Выручка по дате ПЛАТЕЖА, а не заказа | `docs/06` §4 | фильтр `paidAt` | `reports.service.spec.ts` |
| 2.11 | Только подтверждённые платежи | `docs/06` §4 | `status: CONFIRMED` | `reports.service.spec.ts` |
| 2.11 | Возвраты вычитаются из чистой выручки | `docs/06` §4 | `netRevenueMinor` | `reports.service.spec.ts` |
| 2.11 | Средний чек на число заказов, не платежей | `docs/07` §12.4 | `gross / orderCount` | `reports.service.spec.ts` |
| 2.11 | Неделя начинается с понедельника | `docs/07` §12.4 | `periodKey()` | `reports.service.spec.ts` |
| 2.11 | Нулевые способы оплаты присутствуют в итогах | `docs/07` §12.4 | `methodTotals()` | `reports.service.spec.ts` |
| 2.11 | Область видимости по магазину ВНЕСЕНИЯ платежа | `docs/06` §5 | `storeScopeFilter()` | `reports.service.spec.ts` |
| 2.11 | Отчёт «Предоплаты» | `docs/06` §5 | `Payment.kind = PREPAYMENT` | `reports.service.spec.ts` |
| 2.11 | Разрез по магазину внесения, а не заказа | `docs/06` §5 | `Payment.storeId` | `reports.service.spec.ts` |
| 2.11 | Зачтённые и «в работе» разделены | `docs/06` §5 | `status === COMPLETED` | `reports.service.spec.ts` |
| 2.11 | Зависшие: нет работ дольше 14 дней | `docs/06` §5 | `STUCK_PREPAYMENT_DAYS` | `reports.service.spec.ts` (2 теста) |
| 2.11 | Экспорт XLSX/CSV для всех отчётов | `docs/06` §6.4, `docs/07` §12.3 | `ReportsExportService` | `reports-export.service.spec.ts` |
| 2.11 | Деньги выгружаются в рублях, а не копейках | `docs/07` §12.3 | `cellValue()` | `reports-export.service.spec.ts` |
| 2.11 | Числа остаются числами (Excel суммирует) | `docs/07` §12.3 | `cellValue()` | `reports-export.service.spec.ts` |
| 2.11 | CSV: BOM, `;`, CRLF, экранирование | `docs/07` §12.3 | `toCsv()`, `csvEscape()` | `reports-export.service.spec.ts` (7 тестов) |
| 2.11 | XLSX читается обратно как книга Excel | `docs/07` §12.3 | `toXlsx()` | `reports-export.service.spec.ts` |
| 2.11 | Выгрузка уважает права (`report:export`) | `docs/06` §6.4 | `assertCanExport()` | `reports-export.service.spec.ts` |
| 2.11 | Кассир видит выручку, но не загрузку цеха | `docs/07` §12.2.1 | `REPORT_PERMISSION` | `reports.spec.ts` (4 теста) |
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