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

### Этап 7. Доработка логистики (задание `docs/16`, дефекты 58–64)

Требования ТЗ п. 2.6–2.8 были реализованы на сервере ещё на этапе 2, но
**проверить их сотрудником было нельзя**: интерфейса партий не существовало,
исполнителя нельзя было назначить, отказ недостижим. Строки ниже показывают, чем
именно закрыт разрыв, — по приёмке `docs/04` §2 и `docs/16` §5.

| ТЗ | Требование | Документ | Код | Тест |
|----|-----------|----------|-----|------|
| 2.6 | **Интерфейс партий: список, создание, карточка** (задача 7.6, дефект 58) | `docs/08` §3 | `/batches`, `/batches/new`, `/batches/[id]`; `lib/batches.ts` | `batches.spec.ts` в web (23 теста); мутации: предупреждение → отказ и отправка черновика убиваются |
| 2.6 | Подбор заказов с объяснением отказа (задача 7.6) | `docs/07` §8.1 | `GET /batches/:id/candidates` → `partitionBatchCandidates()` | `batches.spec.ts` (группы), web `candidateViews` |
| 2.6 | Предупреждение о чужом магазине не блокирует (решение заказчика) | `docs/16` §2 | `checkBatchEligibility()` → поле `warning` | web `batches.spec.ts`: «предупреждение не превращается в отказ» (падает при мутации) |
| 2.6 | Доступность действий — один источник с сервером | `docs/15` «Дефект 26» | `canDispatchBatch()` и др. из `@app/shared` | web `batches.spec.ts`: недоступная операция обязана иметь причину (обход всех статусов) |
| 2.8 | «Принят цехом» / «Выдано в работу» / «Работы завершены» (задача 7.1) | `docs/04` §1 | `ORDER_STATUS`, `STATUS_LABELS`, миграция `20260925000000` | `order-status.spec.ts`, `docs-sync.spec.ts` |
| 2.8 | **Назначение исполнителя и его ФИО в истории** (задача 7.2) | `docs/07` §9.1 | `assignments.service.ts` → `assign()`, `getTimeline()` (`ASSIGNMENT`) | `assignments.service.spec.ts` (12 тестов); удаление `create` убивает тест |
| 2.8 | Приёмка работы менеджером | `docs/07` §9.1 | `assignments.service.ts` → `finish()` | `assignments.service.spec.ts` |
| 2.8 | Перераспределение закрывает прежнее назначение (дефект 60) | `docs/15` | `RESET_PERFORMER` → `orderAssignment.updateMany(RETURNED)` | `order-workflow.service.spec.ts`: 2 теста падают при возврате прежнего поведения |
| 2.6 | Возврат «без работ»: отказ до начала работ (задача 7.3) | `docs/04` §2 | переходы 26, 27 с обязательной причиной | `order-transitions.spec.ts`, `docs-sync.spec.ts` |
| 2.6 | Получатель обратной партии — магазин приёма (задача 7.4, дефект 62) | `docs/16` §2 | `batchOrderTargetStatus()` | `batches.spec.ts`; `batches.service.spec.ts` |
| 2.5 | **Акт отказа от оплаты** (задача 7.5, дефект 61) | `docs/07` §9.2 | `orders.service.ts` → `createRefusalAct()`, `buildRefusalActNo()` | `refusal-act.spec.ts` (10 тестов); удаление `create` убивает 2, смена scope — 1, снятие защиты дубля — 2 |
| 2.6 | Номер акта отказа не совпадает с номером акта партии | `docs/16` §2 | общий `Counter` `ACT:ГГГГ` | `refusal-act.spec.ts` |
| 2.1 | **Приёмщик может быть логистом** (задача 7.7) | `docs/02` §4 | вторая запись `UserRole`; `seed.ts` `extraRoles` | `seed` идемпотентен (проверено повторным прогоном) |
| 2.10 | **Области видимости ролей объединяются** (дефект 65) | `docs/02` §3 | `resolveDataScopes()`, `buildOrderScopeFilter()` с `OR` по областям | shared `data-scope.spec.ts` (12), api `prisma-scope.spec.ts` (12); выбор одной «широкой» области убивает 6 |
| 2.1 | Переходы учитывают ВЕСЬ набор ролей (дефект 64) | `docs/15` | `checkTransition()` → `rulesAllow()`, `actorRoles` | `order-transitions.spec.ts` (4 теста); принудительное `roles = [actorRole]` убивает 2 |
| 2.1 | Матрица прав `RECEIVER` не расширена | `docs/02` §4 | права остаются у `LOGISTICIAN` | прогон API: `RECEIVER` без второй роли получает 403 |
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
| 2.8 | **Подпись клиента о получении — есть чем поставить** (дефект 66) | `docs/07` §5 | `POST /orders/:id/pickup-signature` → `pickup-signature.service.ts`, право `order:transition` | api `pickup-signature.spec.ts` (13), web `pickup-signature.spec.ts` (14); удаление записи `pickupSignatureFileId` убивает 3, снятие запрета по статусу — 1 |
| 2.8 | Подпись прикладывается ДО перехода в «Выдан» | `docs/04` §2 | `needsPickupSignature()`, порядок вызовов в `transition-dialog.tsx` | web `pickup-signature.spec.ts`: «переход без подписи не отправляется» |
| 2.8 | Акт отказа при отказе от оплаты | `docs/03` §2 | `RefusalAct`, guard `REFUSAL_ACT_EXISTS` | `order-transitions.spec.ts` |
| 2.8 | Статус «невостребовано» через 30 дней | `docs/02` §5.3 | guard `UNCLAIMED_THRESHOLD`, `addCalendarDays()` | `money-dates.spec.ts` |
| 2.9 | Признак гарантийного заказа | `docs/07` §11 | `Order.isWarranty`, `parentOrderId`; UI — `warranty-order.ts` | `warranty-order.spec.ts` (23 теста) |
| 2.9 | Гарантийный заказ без исходного заказа не отправляется | `docs/07` §11 | `warrantyDraftError()` | `warranty-order.spec.ts` |
| 2.9 | Исходным может быть только выданный заказ | `docs/07` §11 | `canBeWarrantySource()` | `warranty-order.spec.ts` |
| 2.9 | Срок гарантии 6 мес. / 3 мес. (закрепка) | `docs/02` §5.4 | `computeWarrantyUntil()`, `warrantyMonths` | `money-dates.spec.ts` |
| 2.9 | Срок рассмотрения рекламации 10 РАБОЧИХ дней | `docs/07` §11.1 | `computeClaimDueAt()`, `addWorkingDays()` | `claims.spec.ts` (36), `claims.service.spec.ts` |
| 2.9 | Закрытая рекламация не считается просроченной | `docs/07` §11.1 | `isClaimOverdue()` | `claims.spec.ts` |
| 2.9 | Отказ требует причины; терминальные не переоткрываются | `docs/07` §11.3 | `claimTransitionDenial()` | `claims.spec.ts`, `claims.service.spec.ts` |
| 2.9 | Запись рекламации в основном заказе | `docs/07` §11.4 | `orderStatusHistory.create` в `ClaimsService.transition()` | `claims.service.spec.ts` |
| 2.9 | Предупреждение о сроке за 3 рабочих дня, один раз | `docs/07` §11.1 | `ClaimDeadlineService.run()`, `warningSentAt` | `claim-deadline.service.spec.ts` |
| 2.9 | Отчёт по рекламациям | `docs/07` §12.3 | `ReportsService.claims()` | `reports.service.spec.ts` |
| 2.9 | Средний разбор в рабочих днях, исходы раздельно | `docs/07` §12.3 | `workingDaysBetween()` в `claims()` | `reports.service.spec.ts` |
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
| 2.11 | Кэш отчётов: TTL по типу отчёта | `docs/06` §6.2 | `REPORT_TTL_MS` | `reports-cache.service.spec.ts` |
| 2.11 | Годовой срез кэшируется на сутки | `docs/06` §6.2 | `ttlForReport()` по длине периода | `reports-cache.service.spec.ts` |
| 2.11 | Область видимости входит в ключ кэша | `docs/06` §6.2 | `reportCacheKey()` | `reports-cache.service.spec.ts` (утечка при снятии) |
| 2.11 | Порядок магазинов не создаёт лишних записей | `docs/06` §6.2 | `.sort()` в ключе | `reports-cache.service.spec.ts` |
| 2.11 | Просроченная запись не отдаётся | `docs/06` §6.2 | `expiresAt <= now` | `reports-cache.service.spec.ts` |
| 2.11 | Предел размера кэша, вытеснение старых | `docs/06` §6.2 | `MAX_ENTRIES` | `reports-cache.service.spec.ts` (3 теста) |
| 2.11 | Переход статуса сбрасывает кэш | `docs/06` §6.2 | `cache.invalidate()` в `transition` | `order-workflow.service.spec.ts` |
| 2.11 | Отклонённый переход кэш НЕ сбрасывает | `docs/06` §6.2 | сброс после `applyTransition` | `order-workflow.service.spec.ts` |
| 2.11 | Платёж сбрасывает выручку и предоплаты | `docs/06` §6.2 | `invalidate([REVENUE, PREPAYMENTS])` | `payments.service.spec.ts` |
| 2.11 | Платёж не сбрасывает сроки и загрузку цеха | `docs/06` §6.2 | сброс по списку отчётов | `payments.service.spec.ts` |
| 2.11 | Идемпотентный повтор кэш не сбрасывает | `docs/07` §1.3 | ранний выход по ключу | `payments.service.spec.ts` |
| 2.11 | Главный дашборд по ролям | `docs/06` §6.5, `docs/07` §12 | `DashboardService` | `dashboard.service.spec.ts` |
| 2.11 | Блоки дашборда по правам, а не по роли | `docs/06` §6.5 | `visibleDashboardBlocks()` | `dashboard.spec.ts` (8 ролей) |
| 2.11 | Кассир видит деньги, но не загрузку цеха | `docs/06` §6.5 | права блоков | `dashboard.spec.ts`, `dashboard.service.spec.ts` |
| 2.11 | Недоступные блоки не запрашиваются | `docs/06` §6.5 | запрос только видимых | `dashboard.service.spec.ts` |
| 2.11 | Числа дашборда совпадают с отчётами | `docs/06` §6.5 | `ReportsService.build` | `dashboard.service.spec.ts` |
| 2.11 | Денежные блоки за календарный месяц | `docs/06` §6.5 | `currentMonthPeriod()` | `dashboard.service.spec.ts` (4 теста) |
| 2.11 | Период включает текущие сутки целиком | `docs/06` §6.5 | `23:59:59.999` | `dashboard.service.spec.ts` |
| 2.11 | Загрузка цеха — доля; нет данных → `null`, не 0 | `docs/06` §6.5 | `round4(fact/planned)` | `dashboard.service.spec.ts` |
| 2.11 | Дефект: просрочка включала ЗАКРЫТЫЕ заказы | `docs/06` §3 | `OVERDUE_EXCLUDED_STATUSES` | `orders-summary.spec.ts` (3 теста) |
| 2.11 | Набор исключённых статусов един для 4 мест | `docs/06` §3 | воркер, дашборд, отчёт, сводка | `orders-summary.spec.ts` |
| 2.11 | Рекламации «в работе»: только открытые | `docs/06` §6.5 | `OPEN_CLAIM_STATUSES` | `dashboard.service.spec.ts` |
| 2.11 | Выгрузка уважает права (`report:export`) | `docs/06` §6.4 | `assertCanExport()` | `reports-export.service.spec.ts` |
| 2.11 | Кассир видит выручку, но не загрузку цеха | `docs/07` §12.2.1 | `REPORT_PERMISSION` | `reports.spec.ts` (4 теста) |
| 2.11 | Отчёт «Предоплаты» | `docs/06` §5 | `Payment.kind = PREPAYMENT` | этап 5 |
| 3 | Интеграция с 1С | `docs/05` §1 | `AccountingPort`, outbox | этап 3 |
| 3 | Интеграция с IP-АТС | `docs/05` §2 | `TelephonyPort` | этап 4 |
| 3 | СМС/мессенджеры (опционально) | `docs/05` §3, §3.1 | `NotificationPort`, адаптеры `SMS`/`MESSENGER`, `NotificationTemplate` | `sms-notification.adapter.spec.ts` (24 теста), `notification-policy.spec.ts` (19) |
| 3 | Внешние каналы выключены по умолчанию | `docs/05` §3.2 | `NOTIFICATIONS_SMS_ENABLED`, `NOTIFICATIONS_MESSENGER_ENABLED` = `false` | `env.validation.spec.ts` (16 тестов) |
| 3 | Канал требует флага И адреса шлюза | `docs/05` §3.2 | `readSmsSettings()` возвращает `null` при отсутствии любого из условий | `sms-notification.adapter.spec.ts` |
| 3 | Выключенный канал не берётся воркером | `docs/05` §3.1 | `supportedChannels()` без выключенных каналов | `sms-notification.adapter.spec.ts` |
| 3 | Причина выключения видна администратору | `docs/07` §14 | `GET /notifications/channels`, `channelsState()` возвращает `reason` | `notifications.controller.spec.ts` (5 тестов), `sms-notification.adapter.spec.ts` |
| 3 | Список исчерпавших попытки доступен администратору | `docs/07` §14 | `GET /notifications/exhausted`, право `settings:manage` | `notifications.controller.spec.ts` |
| 3 | Номер приводится к E.164 перед отправкой | `docs/05` §6.3 | `normalizePhone()` в адаптере | `sms-notification.adapter.spec.ts` |
| 3 | Неверный номер — постоянная ошибка без запроса к шлюзу | `docs/05` §6.3 | проверка до `fetch`, `retryable: false` | `sms-notification.adapter.spec.ts` |
| 3 | Классификатор ошибки HTTP не переиспользует SMTP-логику | `docs/05` §3.1 | `isRetryableHttpStatus()` отдельно от `isRetryableByCode()` | `notification.port.spec.ts` (21 тест) |
| 3 | `408`/`429` временные, остальные `4xx` постоянные | `docs/05` §3.1 | `isRetryableHttpStatus()` | `notification.port.spec.ts` |
| 3 | Ошибка сети не выходит из адаптера | `docs/05` §6.3 | `try/catch` вокруг запроса | `sms-notification.adapter.spec.ts` |
| 3 | Текст длиннее 70 символов не влезает в одно SMS | `docs/05` §6.3 | `fitsSingleSms()`, `SMS_SINGLE_LENGTH` | `notification-policy.spec.ts` |
| 3 | Все SMS-шаблоны влезают в одно сообщение | `docs/05` §3.1 | подстановка значений и замер длины | `notification-templates.spec.ts` (15 тестов) |
| 3 | У SMS и мессенджера нет темы | `docs/05` §3.1 | `subject: null` у этих каналов | `notification-templates.spec.ts` |
| 3 | Тексты каналов различаются, клиентские не дублируют служебные | `docs/05` §3.1 | отдельные шаблоны по паре «код + канал» | `notification-templates.spec.ts` |
| 3 | Клиентское уведомление не создаётся при выключенном канале | `docs/07` §14 | `notifyCustomer()` без `IN_APP`-записи | `notifications.service.spec.ts` (39 тестов) |
| 3 | Клиенту не создаётся внутренний канал | `docs/07` §14 | проверка канала в `notifyCustomer()` | `notifications.service.spec.ts` |
| 2.7 | Эффект `NOTIFY_CUSTOMER` действительно обрабатывается (дефект 35) | `docs/05` §3.1 | `notifyCustomerOfTransition()` в `OrderWorkflowService` | `order-workflow.service.spec.ts` (32 теста) |
| 2.7 | Повод определяется переходом, а не целевым статусом | `docs/05` §3.1 | `customerEventForTransition(from, to)` | `order-workflow.service.spec.ts`, `notification-policy.spec.ts` |
| 2.7 | Переход с `NOTIFY_CUSTOMER` обязан иметь событие, и наоборот | `docs/05` §3.1 | `transitionKeysWithCustomerEvent()` + проверка согласованности | `notification-policy.spec.ts` (2 теста) |
| 2.7 | Ошибка уведомления не отменяет переход | `docs/05` §3.1 | `try/catch` с записью в журнал | `order-workflow.service.spec.ts` |
| 3 | Событие «заказ принят» действительно возникает (дефект 35) | `docs/04` §2, `docs/05` §3 | `NOTIFY_CUSTOMER` в переходах `DRAFT->ACCEPTED`, `AWAITING_APPROVAL->ACCEPTED` | `notification-policy.spec.ts` |
| 3 | Уведомление сотрудника в интерфейсе и на почте | `docs/05` §3 | `NotificationsService.notifyStaff` | `notifications.service.spec.ts` (10 тестов) |
| 3 | Адресат каналов: `userId` для ленты, адрес для письма | `docs/05` §3 | `notifyStaff` | `notifications.service.spec.ts` |
| 3 | Ключ шаблона — пара «код + канал» (дефект) | `docs/05` §3 | `@@unique([code, channel])` | `notification-templates.spec.ts` |
| 3 | Почтовые тексты существуют для 5 событий | `docs/05` §3 | `TEMPLATE_CHANNEL.EMAIL` | `notification-templates.spec.ts` |
| 3 | Временная и постоянная ошибка различаются | `docs/05` §6.3 | `isRetryableByCode()` | `notification.port.spec.ts` |
| 3 | Постоянная ошибка не повторяется (дефект) | `docs/05` §6.3 | `attempts` сразу в предел | `notification-sender.service.spec.ts` |
| 3 | Три попытки, задержка 1/5/25 мин от последней попытки | `docs/05` §6.3 | `isRetryDue()`, `lastAttemptAt` | `notification.port.spec.ts`, `notification-sender.service.spec.ts` |
| 3 | Порт не бросает исключений | `docs/05` §6.3 | `SendResult` | `notification-adapters.spec.ts` |
| 3 | Неизвестный канал — постоянная ошибка, не исключение | `docs/05` §6.3 | `NotificationDispatcher.dispatch` | `notification-adapters.spec.ts` |
| 3 | Без `SMTP_HOST` канал не настроен, приложение работает | `docs/05` §3 | `readSmtpSettings()` | `notification-adapters.spec.ts` (7 тестов) |
| 3 | Дефект: умолчания `localhost:1025` делали «не настроено» недостижимым | `docs/05` §3 | `env.validation.ts` | `env.validation.spec.ts` (7 тестов) |
| 3 | Шифрование SMTP не выводится из номера порта | `docs/05` §3 | `SMTP_SECURE` | `notification-adapters.spec.ts` |
| 3 | Прочитанные уведомления не отправляются повторно | `docs/05` §6.3 | фильтр статусов воркера | `notification-sender.service.spec.ts` |
| 3 | Ошибка одного уведомления не мешает остальным | `docs/05` §6.3 | цикл воркера | `notification-sender.service.spec.ts` |
| 3 | Сбой уведомления не отменяет приёмку партии | `docs/05` §3 | `notifyBatchReceived` вне транзакции | `batches.service.spec.ts` |
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

### Требования этапа 7 (доработка логистики)

Согласованы с заказчиком при разборе схемы «магазин ⇄ производство»; схема —
`docs/00-decisions.md` §7, задание — `docs/16-logistics-completion.md`, дефекты 58–63 —
`docs/15-known-issues.md`. Раздел фиксирует **расхождения** между прежней реализацией и
согласованным процессом.

| ТЗ | Было в системе | Требуется | Почему |
|----|----------------|-----------|--------|
| 2.6 | Серверная логистика готова, интерфейса партий нет (процесс только через API) | Экран партий: создание, подбор заказов, акт, **печать реестра**, отправка, приём | Дефект 58: сотрудник магазина не мог сформировать партию ни разу |
| 2.10 | Создание партии требует права `logistics:manage`, которого у роли `RECEIVER` нет | Приёмщику, отправляющему партии, назначается **вторая роль `LOGISTICIAN`** | Решение заказчика: матрица прав не расширяется, доступ даётся конкретным людям |
| 2.7 | Один статус `IN_PRODUCTION` на всю производственную часть | Три статуса: **«Принят цехом»**, **«Выдано в работу»**, **«Работы завершены»** | Дефект 63: состояния «принят», «в работе», «работа сдана» были неразличимы |
| 2.7 | Исполнителя производства назначить нельзя (`OrderAssignment` только читается) | Маршрут назначения; статус → «Выдано в работу»; ФИО ювелира **в истории заказа** | Дефект 59: переход «работы завершены» требовал исполнителя и был недостижим — заказ не мог уехать из цеха |
| 2.6 | Обратная партия отбраковывала все заказы (`SAME_STORE` + фильтр по `createdStoreId`) | Получатель — **магазин приёма**; партия не смешивает два магазина | Дефект 62: собрать партию возврата было невозможно |
| 2.6 | «Где приняли, там и выдаём» нигде не проверялось | **Предупреждение** в интерфейсе без блокировки | Решение заказчика: контроль — зона ответственности менеджера |
| 2.8 | Статус «Отказ от оплаты» недостижим: акт отказа никто не создаёт | Маршрут оформления `RefusalAct`; отказ до начала работ завершается возвратом изделия в магазин | Дефект 61: сценарий «клиент отказался» не завершался |
| 2.8 | Отказ возможен только когда изделие уже в магазине | Добавляется переход «вернуть **без работ**» — возврат в магазин до начала работ | Схема заказчика: отказ на этапе согласования, изделие возвращается и выдаётся клиенту в магазине |
| 2.7 | Перераспределение сбрасывало `productionManagerId` вместо исполнителя | Сброс закрывает активные назначения | Дефект 60: эффект `RESET_PERFORMER` делал не то, что назван |

**Возможное отклонение (ждёт подтверждения):** требование «RPO ≤ 5 минут» выполнимо
только при непрерывной архивации WAL (PITR). Если существующая система копирования делает
только периодические дампы, фактический RPO равен интервалу между ними. Тогда требование
помечается здесь как принятое отклонение с указанием фактического значения, а не как
выполненное (`infra/db/README.md` §5.2).

Подробности — `docs/00-decisions.md` §1–§2 и `docs/11-open-questions.md` раздел G.

## Замечания заказчика от 19.09.2026

| № | Требование | Документ | Реализация | Доказательство |
|---|-----------|----------|-----------|----------------|
| Замечание 1 | Вход выбором сотрудника, а не вводом почты | `docs/07` §2.1, `docs/08` §2 | `GET /auth/login-options` (только `id` + `fullName`); `loginSchema` с `userId` или `email`; `loginAs` | 9 тестов `auth.service.spec.ts` + 3 теста `auth.controller.spec.ts`; мутации: снятие `select`/`where`/`orderBy`, снятие `@Public()`, переименование пути, снятие `refine` — убиты. Живой прогон: 9 записей, утечки полей и почты нет, вход по `userId` → Иванова М. С. (RECEIVER), вход по `email` работает, запрос без обоих полей → 400 |
| Замечание 2 | Поле «Металл» — выпадающий список | `docs/15` «Дефект 39» | `METAL_OPTIONS`, `metalOptionValue`, `<Select>` в мастере приёма | 7 тестов `metal-kind.spec.ts` (всего 14); мутация `metalOptionValue` → `''` — убита | 
| Замечание 3 | Правка прайс-листа в справочниках администратора | `docs/09` 1.4.2–1.4.3, `docs/15` «Дефект 38» | Записывающие маршруты прейскуранта (`PriceListAdminService`, 12 маршрутов) + вкладка «Прейскурант» на экране «Справочники» | 31 тест `price-list-admin.service.spec.ts`, 19 + 3 теста домена, 8 тестов `roles.guard.spec.ts`. Мутации: снятие `assertEditable` в `updateVersion` — убито 4 тестами (тесты нашли реальный дефект: проверка отсутствовала); безусловный пропуск `ADMIN` в `RolesGuard` — убит; возврат `pricelist:approve` администратору — убит; `ARCHIVED` → `ARCHIVED_OLD` — убит 3 тестами. Живой прогон: правка утверждённой версии → `PRICE_LIST_APPROVED_IMMUTABLE`, копия → v2 DRAFT с 24 позициями и ставками, правка ставок заменяет их целиком, отправка → `PENDING_APPROVAL`, администратор → 403 `FORBIDDEN_ROLE`, руководитель утверждает, предыдущая версия → `ARCHIVED` |
| Находка (безопасность) | Разделение обязанностей при утверждении прейскуранта | `docs/02` §4, `docs/15` «Дефект 38» | `@RequireStrictPermission`, изъятие `pricelist:approve` у администратора | Администратор правил цены и он же их утверждал: `RolesGuard` пропускал `ADMIN` раньше проверки прав, а `ROLE_PERMISSIONS[ADMIN]` выдавал все права. Проверено живым прогоном до и после: `/auth/me` администратора → `pricelist:approve: false`, `POST /price-lists/:id/approve` → 403; руководитель → 200 |
| Задача 5.11 | Публичная проверка статуса заказа | `docs/07` §15, `docs/05` §5, `docs/08` §2.0 | `PublicStatusService`, `PublicStatusController`, страница `/status`; доменные правила в `public-order-status.ts` | 33 теста домена, 23 теста сервиса, 8 тестов контроллера. Мутации: черновик виден — убито; снятие счётчика попыток — убито; снятие проверки срока, телефона, блокировки, хеша, лимита, публичности — убиты (7 из 7). Живой прогон: код → SMS → верный код открывает заказ → повтор даёт `NOT_FOUND`; 5 неверных попыток гасят код; ответы неотличимы для существующего и несуществующего заказа |
| Находка (безопасность) | Публичный ответ не должен выдавать существование заказа | `docs/05` §5.2, `docs/15` «Дефект 42» | Поле `phoneMask` убрано из ответа на запрос кода | Первый вариант ответа содержал маску телефона, заполнявшуюся только при существующем заказе и совпавшем телефоне, — поле само было оракулом. Найдено тестом на неотличимость; добавлен тест, перебирающий все случаи отказа и требующий одинакового отпечатка `{ sent: true }` |
| Находка (эксплуатация) | Флаги каналов в окружении не действовали никогда | `docs/15` «Дефект 41» | `envFlag` в `apps/api/src/config/env.validation.ts`; применён в `notifications.service.ts`, `sms-notification.adapter.ts`, `email-notification.adapter.ts` | Схема приводит флаг к булеву значению, а код сравнивал его со строкой `'true'` — SMS, мессенджер и **шифрование почты** молча оставались выключенными. Найдено на живой проверке 5.11. Регрессия: `env-flag.spec.ts` запрещает сравнение этих флагов со строкой во всём исходном коде API (проверка читает файлы — молчаливо выключенный канал не проявляется функционально) |
| Находка (безопасность) | Внутренняя причина не должна попадать в публичный ответ | `docs/05` §5.2, `docs/15` «Дефект 44» | Контроллер собирает ответ явными литералами: `{ sent }` и `{ ok, view }` | Контроллер возвращал результат сервиса целиком, вместе с `reason` (`ORDER_NOT_FOUND`, `PHONE_MISMATCH`), — это был тот самый оракул для перебора номеров заказов. Тесты сервиса исключали `reason` из сравнения, поэтому дефект не ловили; найден на живой проверке сервера. 5 тестов `public-status.e2e-shape.spec.ts` сравнивают ответ контроллера со строгим литералом и требуют одинакового отпечатка при всех причинах |
| Находка (эксплуатация) | Ограничение частоты не должно мешать клиенту | `docs/15` «Дефект 43» | Лимит по адресу выше лимитов по телефону: 20/час и 30/мин | Живой дефект: с лимитом 10/мин клиент получал `429` на четвёртой попытке, раньше счётчика попыток (5), и не мог воспользоваться оставшимися. Тесты требуют, чтобы лимит по адресу был строго больше числа попыток |
| Находка (доступность) | Утверждающий видит цены, которые подписывает | `docs/02` §4, `docs/15` «Дефект 38» | `GET /price-lists/:id/editor` принимает и `pricelist:edit`, и `pricelist:approve` | Живой дефект: руководитель получал 403 на карточке версии, то есть утверждал по номеру. 7 тестов `price-list-admin.controller.spec.ts`; мутации снятия второго права и снятия строгой проверки — убиты. После правки: руководитель и главбух читают карточку (200), но правку по-прежнему получают 403 |
| Замечание 4 | «Изменить пароль пользователя — нет кнопки сохранить, при закрытии изменения не записываются» | `docs/15` «Дефект 45», `docs/09` 1.2.4 | `UserDetailDialog` в `apps/web/src/app/(app)/users/page.tsx`; правила в `apps/web/src/lib/user-edit.ts`; `updateUserSchema` принимает пустой телефон | Карточка сотрудника не сохраняла изменения вообще: кнопки «Сохранить» не было, ФИО/почта/телефон/магазины выводились текстом, сброс пароля был серой кнопкой без объяснения причины, а очистка телефона отклонялась схемой. 29 тестов `user-edit.spec.ts`, 13 тестов `schemas-users.spec.ts`, 5 новых тестов `users.service.spec.ts`. Мутации: отправка неизменённого ФИО — убито 11 тестами; пропуск очищенного телефона — убито 2; сравнение магазинов по порядку — убито 2; снятие проверки длины набора магазинов — убито 1; отсутствие обрезки пробелов — убито 1; `phoneSchema` без пустого значения — убито 2; телефон без проверки формата — убито 3; сохранение `''` вместо `null` в базу — убито 2; стирание телефона при его отсутствии в запросе — убито 1 |
| Замечание 4 | Правка дат версии прейскуранта | `docs/15` «Дефект 46», `docs/07` §12 | `PriceListPeriodEditor` в `price-list-section.tsx`; правила в `apps/web/src/lib/price-list-period.ts` | Даты версии только отображались, `effectiveTo` не показывался вовсе; задать их было можно лишь при копировании версии. 16 тестов `price-list-period.spec.ts`. Мутации: сравнение дат по исходной строке ISO — убито 4 тестами; пропуск снятия даты окончания — убито 1; трактовка дня как местного времени — убито 5; снятие проверки «окончание позже начала» — убито 2; снятие требования даты начала — убито 1; отсутствие защиты от некорректной даты — убито 1. Живой прогон: `PATCH /price-lists/:id` → 200 |
| Дефект 67 (этап 7) | Отказ клиента до начала работ закрывает заказ | `docs/00` §7.3, `docs/04` §2 (переход 29), `docs/16` §2.3 | Статус `REFUSED_BEFORE_WORK`; `returnedWithoutWorkAt`; эффект `MARK_RETURNED_WITHOUT_WORK` (переходы 26/27); `batchOrderTargetStatus` с отметкой; per-order цель в `batches.service.ts`; `BatchItemDto.returnedWithoutWork`; `receiveConsequences` | 4 теста shared (`batches.spec.ts`), 3 теста API (`batches.service.spec.ts`), 3 теста веб (`batches.spec.ts`). Мутации: безусловный `READY_FOR_PICKUP` — убито 2 API + 2 shared; единый статус на партию — убито 2 API; сокрытие отказов в тексте приёмки — убито 2 веб. Живой прогон на проде: возврат без работ (26) → приёмка → «Отказ до начала работ» |
| Запрос заказчика (дефект 68) | Плитка «Обзор» открывает список заказов с этим статусом | `docs/06` §6.6, `docs/08` §1, `docs/15` «Дефект 68» | `DASHBOARD_COUNTERS`, `counterListHref`, `summaryFromCounts`, `OVERDUE_EXCLUDED_STATUSES` в `order-counters.ts`; `findAll` при `overdue`; `StatCard` как `<Link>`; `DASHBOARD_COUNTER_LABELS` | 20 тестов домена, 4 теста API, 5 тестов веб. Мутации: `overdue` из общего числа — убито 1; «в производстве» по одному статусу — убито 2; счётчик просрочки по статусу — убито 2; адрес теряет фильтр — убито 3; статусы через `;` — убито 3; список без набора исключений — убито 1 |
| Дефект 69 (найден живой сверкой дефекта 68) | `/orders?status=A,B` из адресной строки работает; неизвестный статус → 400, а не 500 | `docs/07` §1.2.1, `docs/15` «Дефект 69» | `parseStatusFilter` в `order-status.ts`; `OrdersController.findAll` | 12 тестов домена, 9 тестов API. Живая проверка: `A,B` → 200, `A&status=B` → 200, `BOGUS` → 400, `A,BOGUS` → 400, `status=` → 200. Мутации: разбор без деления по запятой (исходный дефект) — убито 2; неизвестные молча отбрасываются — убито 3; пустой набор → `{in:[]}` — убито 4 |
| Требование заказчика (дефект 70) | Исполнителя можно указать в интерфейсе при передаче заказа | `docs/08` §3, `docs/15` «Дефект 70» | `AssignPerformerDialog`, блок «Исполнитель» в карточке, `assignments` в `OrderDetail` | Живая проверка: исполнитель указан, заказ переведён в «Выдано в работу». Видимость кнопки — из `availableTransitions` |
| Требование заказчика (дефект 72) | Добавление, изменение и удаление видов работ | `docs/07` §1, `docs/15` «Дефект 72» | `OrderWorksService`, маршруты `/orders/:id/works`, `WorksEditor`, право `calc:composition` | 19 тестов API, 7 тестов домена. Живая проверка: добавление, изменение (пересчёт суммы строки), удаление, запрет удаления последней, обязательная причина, 403 у приёмщика. Мутации: нет пересчёта — 3; правка после выдачи — 2; цена из тела — 1; граница по этапам — 2 |
| Требование заказчика (дефект 71) | При изменении стоимости обязательно согласование; без него заказ в работу не передаётся | `docs/04` §2 (переход 23), `docs/07` §1.2.2, `docs/15` «Дефект 71» | `GUARD.APPROVAL_COVERS_TOTAL`, `checkApprovalCoverage`, `approvalCoverage` в карточке | 11 тестов домена, 7 тестов API. Живая проверка E2E: 100 000 → добавлена работа → 170 000 → выдача `409 APPROVAL_STALE` → согласование → выдача прошла. Мутации: только наличие — 5; нестрогое сравнение — 4; null как ноль — 2 |
| Запрос заказчика (дефект 76) | При отправке из цеха в магазин отправитель — цех, выбирается автоматически | `docs/07` §8, `docs/15` «Дефект 76» | `Batch.fromWorkshopId` (миграция), `batchSenderKind`, `resolveBatchSourceWorkshop`, `batchSourceWorkshopMessage`; форма без выбора магазина-отправителя для направления «в магазин» | 20 тестов домена, 9 тестов API, 5 тестов формы. Живая проверка обоих путей: с заказом сразу и пустая партия. Мутации: отправитель-магазин (исходный дефект) — 2; смешанные цеха — 1; общая проверка формы — 2; цех не проставляется — 1; магазин сохраняется — 1; пустая партия запрещена — 2 |
