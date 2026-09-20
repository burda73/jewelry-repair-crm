'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  api,
  buildQuery,
  describeApiError,
  requestBlob,
  withIdempotencyKey,
} from '@/lib/api-client';
import { formatMinor } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import type {
  OrderDetail,
  ItemPhotoView,
  OrderFilters,
  OrderListResponse,
  OrderPayment,
  PaymentKind,
  PaymentMethod,
  CreatedOrderResponse,
  CustomerDetail,
  CustomerSearchItem,
  PaymentResult,
  OrderAssignment,
  PerformerOption,
  PriceListItemEditorInput,
  PriceListItemOption,
  PriceListVersionDetail,
  PriceListVersionItem,
  SearchResultItem,
  StoneTypeOption,
  StoreOption,
  TimelineEntry,
  Batch,
  BatchCandidateGroup,
  BatchDetail,
  WorkCategoryOption,
  WorkshopOption,
  LoginOption,
  RolesCatalog,
  UserCreateInput,
  UserDetail,
  UserFilters,
  UserListItem,
  UserUpdateInput,
  StoreAdminItem,
  StoreAdminInput,
  WorkshopAdminItem,
  WorkshopAdminInput,
  PerformerAdminItem,
  PerformerAdminInput,
  WorkCategoryAdminItem,
  WorkCategoryAdminInput,
  StoneTypeAdminItem,
  StoneTypeAdminInput,
  CalendarDayItem,
  CalendarDayInput,
  CalendarListResponse,
  CalendarMonthSummary,
  NormVersion,
  CreateNormVersionInput,
} from '@/lib/api-types';
import type { CustomerInput, OrderStatus } from '@app/shared';

/** Ключи кэша — в одном месте, чтобы инвалидация не промахивалась. */
export const orderKeys = {
  all: ['orders'] as const,
  list: (filters: OrderFilters, search: string) => ['orders', 'list', filters, search] as const,
  detail: (id: string) => ['orders', 'detail', id] as const,
  timeline: (id: string) => ['orders', 'timeline', id] as const,
  search: (term: string) => ['orders', 'search', term] as const,
  payments: (orderId: string) => ['orders', 'payments', orderId] as const,
  photos: (orderId: string, itemId: string) => ['orders', 'photos', orderId, itemId] as const,
};

/**
 * Сбросить данные карточки заказа: саму карточку и её ленту событий.
 *
 * Нужно там, где маршрут меняет заказ, но возвращает НЕ его карточку (например,
 * назначение исполнителя отдаёт назначение). Без сброса сотрудник видел бы
 * старое состояние до перезагрузки страницы — так и было с выдачей и приёмкой
 * работы: действие выполнялось, а экран не менялся.
 *
 * Список заказов сбрасывается тоже: статус виден и в нём.
 */
function invalidateOrderCard(
  queryClient: ReturnType<typeof useQueryClient>,
  orderId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: orderKeys.detail(orderId) });
  void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(orderId) });
  void queryClient.invalidateQueries({ queryKey: orderKeys.all });
}

/** Ключи запросов логистики (задачи 2.6–2.7). */
export const batchKeys = {
  all: ['batches'] as const,
  list: (filters: Record<string, string>) => ['batches', 'list', filters] as const,
  candidates: (id: string) => ['batches', 'candidates', id] as const,
  myDeliveries: () => ['batches', 'my-deliveries'] as const,
  detail: (id: string) => ['batches', 'detail', id] as const,
  scan: (code: string) => ['batches', 'scan', code] as const,
};

/**
 * Список заказов с фильтрами.
 *
 * Пагинация — keyset: сервер отдаёт `nextCursor`, и «показать ещё»
 * запрашивает следующую страницу. Offset-пагинация на больших объёмах
 * деградирует (docs/01-architecture.md §6), поэтому её нет и в API.
 */
export function useOrders(
  filters: OrderFilters,
  search: string,
  cursor: string | null,
): UseQueryResult<OrderListResponse> {
  return useQuery({
    queryKey: [...orderKeys.list(filters, search), cursor],
    queryFn: () =>
      api.get<OrderListResponse>(
        `/orders${buildQuery({
          status: filters.status,
          storeId: filters.storeId,
          overdue: filters.overdue === true ? 'true' : undefined,
          isWarranty: filters.isWarranty,
          priority: filters.priority,
          orderNo: search !== '' ? search : filters.orderNo,
          customerPhone: filters.customerPhone,
          cursor: cursor ?? undefined,
          limit: 50,
        })}`,
      ),
  });
}

export function useOrder(id: string): UseQueryResult<OrderDetail> {
  return useQuery({
    queryKey: orderKeys.detail(id),
    queryFn: () => api.get<OrderDetail>(`/orders/${id}`),
    enabled: id !== '',
  });
}

export function useOrderTimeline(id: string): UseQueryResult<TimelineEntry[]> {
  return useQuery({
    queryKey: orderKeys.timeline(id),
    queryFn: () => api.get<TimelineEntry[]>(`/orders/${id}/timeline`),
    enabled: id !== '',
  });
}

/** Глобальный поиск: номер, телефон или ФИО. */
export function useSearch(term: string): UseQueryResult<SearchResultItem[]> {
  const trimmed = term.trim();
  return useQuery({
    queryKey: orderKeys.search(trimmed),
    queryFn: () => api.get<SearchResultItem[]>(`/orders/search${buildQuery({ q: trimmed })}`),
    // Сервер требует минимум 3 символа — иначе запрос вернул бы 400.
    enabled: trimmed.length >= 3,
  });
}

interface TransitionVariables {
  orderId: string;
  to: OrderStatus;
  version: number;
  reason?: string;
}

/**
 * Переход статуса.
 *
 * Кнопки действий берутся из `availableTransitions`, полученных от сервера:
 * фронтенд не дублирует матрицу прав (docs/08-ui-ux.md §1.4). Сервер
 * повторно проверяет всё сам, поэтому подделка запроса ничего не даст.
 */
export function useTransition(): UseMutationResult<OrderDetail, Error, TransitionVariables> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<OrderDetail, Error, TransitionVariables>({
    mutationFn: ({ orderId, to, version, reason }: TransitionVariables) =>
      api.post<OrderDetail>(`/orders/${orderId}/transition`, { to, version, reason }),
    onSuccess: (order) => {
      toast.showSuccess('Статус изменён');
      // Обновляем и карточку, и список: статус виден в обоих местах.
      queryClient.setQueryData(orderKeys.detail(order.id), order);
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(order.id) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/** Отмена заказа: причина обязательна (ТЗ п. 2.3). */
export function useCancelOrder(): UseMutationResult<
  OrderDetail,
  Error,
  { orderId: string; version: number; reason: string }
> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<OrderDetail, Error, { orderId: string; version: number; reason: string }>({
    mutationFn: ({
      orderId,
      version,
      reason,
    }: {
      orderId: string;
      version: number;
      reason: string;
    }) => api.post<OrderDetail>(`/orders/${orderId}/cancel`, { version, reason }),
    onSuccess: (order) => {
      toast.showSuccess('Заказ отменён');
      queryClient.setQueryData(orderKeys.detail(order.id), order);
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(order.id) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/**
 * Платежи по заказу.
 *
 * Отдельный запрос, хотя платежи есть и в карточке: они меняются чаще карточки
 * (кассир принимает деньги, пока приёмщик смотрит заказ), и их точечная
 * инвалидация дешевле, чем перезагрузка всего заказа.
 */
export function useOrderPayments(orderId: string): UseQueryResult<OrderPayment[]> {
  return useQuery<OrderPayment[], Error>({
    queryKey: orderKeys.payments(orderId),
    queryFn: () => api.get<OrderPayment[]>(`/orders/${orderId}/payments`),
    enabled: orderId !== '',
  });
}

export interface CreatePaymentVariables {
  orderId: string;
  kind: PaymentKind;
  method: PaymentMethod;
  amountMinor: number;
  storeId: string;
  paidAt: string;
  receiptNo?: string;
  comment?: string;
}

/**
 * Принять платёж.
 *
 * `Idempotency-Key` генерируется здесь — до отправки запроса. Это принципиально:
 * ключ должен быть создан ОДИН раз на попытку пользователя и не меняться при
 * повторе того же вызова (retry при обрыве связи). Если бы ключ генерировался
 * заново при каждом сетевом повторе, защита от двойного списания не работала бы.
 */
export function useCreatePayment(): UseMutationResult<
  PaymentResult,
  Error,
  CreatePaymentVariables
> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<PaymentResult, Error, CreatePaymentVariables>({
    mutationFn: ({ orderId, ...body }: CreatePaymentVariables) =>
      api.post<PaymentResult>(`/orders/${orderId}/payments`, body, {
        headers: { 'Idempotency-Key': withIdempotencyKey() },
      }),
    onSuccess: (result) => {
      // Тост показывает вызывающий экран: он знает контекст (например, остаток
      // после платежа). Здесь сообщение не выводится, чтобы не было двух тостов.
      // Обновляем и платежи, и карточку: `paidAmountMinor` и `canStartWork`
      // в карточке уже изменились, и показывать старое значение нельзя.
      void queryClient.invalidateQueries({ queryKey: orderKeys.payments(result.payment.orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(result.payment.orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(result.payment.orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/** Сторно платежа: причина обязательна (требование финансового учёта). */
export function useReversePayment(): UseMutationResult<
  PaymentResult,
  Error,
  { paymentId: string; reason: string }
> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<PaymentResult, Error, { paymentId: string; reason: string }>({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      api.post<PaymentResult>(`/payments/${paymentId}/reverse`, { reason }),
    onSuccess: (result) => {
      toast.showSuccess('Платёж отменён (сторно)');
      void queryClient.invalidateQueries({ queryKey: orderKeys.payments(result.payment.orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(result.payment.orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(result.payment.orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/** Данные согласования: канал, результат, согласованная сумма и срок. */
export interface CreateApprovalVariables {
  orderId: string;
  channel: 'IN_PERSON' | 'PHONE_VERBAL' | 'SMS' | 'MESSENGER' | 'EMAIL';
  result: 'PENDING' | 'APPROVED' | 'REJECTED' | 'NO_ANSWER' | 'CHANGED';
  amountMinor: number;
  termDays?: number;
  comment?: string;
}

/**
 * Зафиксировать согласование клиента (ТЗ п. 2.4).
 *
 * Ответ — карточка заказа целиком, поэтому инвалидируем и её: без этого
 * вкладка «Согласования» и статусная шапка показывали бы состояние до
 * согласования, а кнопка перехода осталась бы заблокированной, хотя
 * guard уже пропустил бы заказ.
 */
export function useCreateApproval(): UseMutationResult<
  OrderDetail,
  Error,
  CreateApprovalVariables
> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<OrderDetail, Error, CreateApprovalVariables>({
    mutationFn: ({ orderId, ...body }: CreateApprovalVariables) =>
      api.post<OrderDetail>(`/orders/${orderId}/approvals`, body),
    onSuccess: (_order, variables) => {
      /*
       * Сообщение зависит от результата разговора, а не от факта сохранения:
       * «согласование зафиксировано» и «клиент отказался» — разные события
       * для приёмщика, и одинаковый тост заставил бы его перепроверять карточку.
       */
      toast.showSuccess(
        variables.result === 'APPROVED'
          ? 'Согласование зафиксировано'
          : 'Результат разговора сохранён',
      );
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(_order.id) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(_order.id) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/** Корректировка калькуляции: цель, новая сумма и обязательная причина. */
export interface CreateAdjustmentVariables {
  orderId: string;
  targetType: 'WORK' | 'STONE' | 'TOTAL';
  targetId?: string;
  amountAfterMinor: number;
  reason: string;
}

/**
 * Скорректировать калькуляцию (ТЗ п. 2.3).
 *
 * Сумма заказа меняется только этим запросом — прямого «сохранить сумму»
 * в API нет, иначе причина правки терялась бы.
 */
export function useCreateAdjustment(): UseMutationResult<
  OrderDetail,
  Error,
  CreateAdjustmentVariables
> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<OrderDetail, Error, CreateAdjustmentVariables>({
    mutationFn: ({ orderId, ...body }: CreateAdjustmentVariables) =>
      api.post<OrderDetail>(`/orders/${orderId}/adjustments`, body),
    onSuccess: (order) => {
      toast.showSuccess(`Сумма заказа: ${formatMinor(order.totalAmountMinor)}`);
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(order.id) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(order.id) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/**
 * Печать квитанции: запросить PDF с сервера и открыть его на печать.
 *
 * Почему не `window.print()` карточки заказа: квитанция — документ, который
 * уходит клиенту, и она не должна зависеть от вида страницы (меню, кнопки,
 * масштаб браузера). Сервер отдаёт готовый PDF, а браузер показывает его
 * во встроенном просмотрщике, откуда сотрудник печатает.
 *
 * PDF открывается в новой вкладке через blob-URL: cookie остаются в силе
 * (в отличие от прямой ссылки на API), а адрес файла не попадает в историю
 * браузера с номером заказа.
 */
export function usePrintReceipt(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<void, Error, string>({
    mutationFn: async (orderId: string) => {
      const blob = await requestBlob(`/orders/${orderId}/receipt`);
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, '_blank');
      if (opened === null) {
        // Всплывающее окно заблокировано браузером — скачиваем файл, чтобы
        // сотрудник всё равно получил квитанцию и не остался без документа.
        const link = document.createElement('a');
        link.href = url;
        link.download = 'receipt.pdf';
        link.click();
      }
      // Освобождаем память после того, как вкладка загрузила документ.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    onSuccess: (_result, orderId) => {
      // Счётчик перепечаток увеличился на сервере — обновляем карточку,
      // чтобы новая копия была видна в истории.
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(orderId) });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/**
 * Фотографии изделия.
 *
 * Отдельный ключ, а не часть карточки заказа: после загрузки фото нужно
 * обновить только список фотографий, а не всю карточку с платежами и историей.
 * Карточка при этом тоже инвалидируется — фото приходят и в ней.
 */
export function useItemPhotos(orderId: string, itemId: string): UseQueryResult<ItemPhotoView[]> {
  return useQuery<ItemPhotoView[]>({
    queryKey: orderKeys.photos(orderId, itemId),
    queryFn: () => api.get<ItemPhotoView[]>(`/orders/${orderId}/items/${itemId}/photos`),
    enabled: orderId !== '' && itemId !== '',
  });
}

/** Загрузить фотографии изделия — одним запросом, сколько бы файлов ни выбрали. */
export function useUploadPhoto(
  orderId: string,
  itemId: string,
): UseMutationResult<
  ItemPhotoView[],
  Error,
  { files: File[]; kind: 'INTAKE' | 'DEFECT' | 'RESULT' | 'AFTER_REPAIR' }
> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<
    ItemPhotoView[],
    Error,
    { files: File[]; kind: 'INTAKE' | 'DEFECT' | 'RESULT' | 'AFTER_REPAIR' }
  >({
    mutationFn: async ({ files, kind }) => {
      // `FormData` без ручного `Content-Type`: браузер сам добавит boundary,
      // а заданный вручную заголовок его сломает и сервер не разберёт файлы.
      const form = new FormData();
      for (const file of files) form.append('files', file);
      form.append('kind', kind);
      return api.postForm<ItemPhotoView[]>(`/orders/${orderId}/items/${itemId}/photos`, form);
    },
    onSuccess: (photos) => {
      toast.showSuccess(
        photos.length === 1 ? 'Фотография добавлена' : `Добавлено фотографий: ${photos.length}`,
      );
      void queryClient.invalidateQueries({ queryKey: orderKeys.photos(orderId, itemId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(orderId) });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/** Удалить фотографию изделия. */
export function useDeletePhoto(
  orderId: string,
  itemId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation<void, Error, string>({
    mutationFn: (photoId: string) => api.delete<void>(`/photos/${photoId}`),
    onSuccess: () => {
      toast.showSuccess('Фотография удалена');
      void queryClient.invalidateQueries({ queryKey: orderKeys.photos(orderId, itemId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(orderId) });
    },
    onError: (error: Error) => {
      toast.showError(describeApiError(error));
    },
  });
}

/**
 * Справочник магазинов.
 *
 * Нужен там, где пользователь выбирает магазин (приём оплаты, фильтры):
 * в объекте пользователя есть только идентификаторы, а показывать клиенту
 * нужно название. `staleTime` увеличен — справочник магазинов меняется
 * крайне редко, и перезапрашивать его на каждое открытие диалога незачем.
 */
export function useStores(): UseQueryResult<StoreOption[]> {
  return useQuery<StoreOption[], Error>({
    queryKey: ['dictionaries', 'stores'],
    queryFn: () => api.get<StoreOption[]>('/stores'),
    staleTime: 10 * 60 * 1000,
  });
}

// ---------------------------------------------------------------------------
// Справочники для мастера создания заказа
// ---------------------------------------------------------------------------

/**
 * Прейскурант и справочники меняются редко, поэтому кэшируются на 10 минут.
 * Мастер создания заказа открывается часто, и перезапрашивать справочники
 * на каждом шаге было бы заметно медленнее без всякой пользы.
 */
const DICTIONARY_STALE_TIME = 10 * 60 * 1000;

/** Позиции действующего (утверждённого) прейскуранта. */
export function usePriceListItems(): UseQueryResult<PriceListItemOption[]> {
  return useQuery<PriceListItemOption[], Error>({
    queryKey: ['dictionaries', 'price-list-items'],
    queryFn: () => api.get<PriceListItemOption[]>('/price-list-items'),
    staleTime: DICTIONARY_STALE_TIME,
  });
}

/** Ключи запросов прейскуранта: список версий и карточка редактора. */
export const priceListKeys = {
  all: ['price-lists'] as const,
  list: ['price-lists', 'list'] as const,
  detail: (id: string) => ['price-lists', 'detail', id] as const,
};

/**
 * Версии прейскуранта для экрана администратора.
 *
 * `staleTime: 0`: в отличие от справочников для мастера приёма, этот список
 * меняется в ходе работы — администратор создаёт версию и сразу видит её.
 * Кэшировать на 10 минут значило бы показывать устаревшее состояние сразу
 * после собственного действия.
 */
export function usePriceListVersions(): UseQueryResult<PriceListVersionItem[]> {
  return useQuery<PriceListVersionItem[], Error>({
    queryKey: priceListKeys.list,
    queryFn: () => api.get<PriceListVersionItem[]>('/price-lists'),
  });
}

/** Версия прейскуранта с позициями для редактора (`GET /price-lists/:id/editor`). */
export function usePriceListVersion(id: string | null): UseQueryResult<PriceListVersionDetail> {
  return useQuery<PriceListVersionDetail, Error>({
    queryKey: priceListKeys.detail(id ?? ''),
    queryFn: () => api.get<PriceListVersionDetail>(`/price-lists/${id ?? ''}/editor`),
    enabled: id !== null,
  });
}

/** Обновлять список версий и карточку редактора после любого изменения. */
function useInvalidatePriceLists(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: priceListKeys.all });
    // Действующий прейскурант меняется при утверждении, поэтому мастер приёма
    // должен получить новые цены, а не показывать старые до истечения кэша.
    void queryClient.invalidateQueries({ queryKey: ['dictionaries', 'price-list-items'] });
  };
}

export function useCreatePriceListVersion(): UseMutationResult<
  PriceListVersionItem,
  Error,
  { storeId?: string; effectiveFrom: string; comment?: string }
> {
  const invalidate = useInvalidatePriceLists();
  return useMutation({
    mutationFn: (input: { storeId?: string; effectiveFrom: string; comment?: string }) =>
      api.post<PriceListVersionItem>('/price-lists', input),
    onSuccess: invalidate,
  });
}

export function useUpdatePriceListVersion(): UseMutationResult<
  PriceListVersionItem,
  Error,
  { id: string; input: Record<string, unknown> }
> {
  const invalidate = useInvalidatePriceLists();
  return useMutation({
    mutationFn: (variables: { id: string; input: Record<string, unknown> }) =>
      api.patch<PriceListVersionItem>(`/price-lists/${variables.id}`, variables.input),
    onSuccess: invalidate,
  });
}

export function usePriceListAction(): UseMutationResult<
  PriceListVersionItem,
  Error,
  { id: string; action: string; body?: Record<string, unknown> }
> {
  const invalidate = useInvalidatePriceLists();
  return useMutation({
    mutationFn: (variables: { id: string; action: string; body?: Record<string, unknown> }) =>
      api.post<PriceListVersionItem>(
        `/price-lists/${variables.id}/${variables.action}`,
        variables.body ?? {},
      ),
    onSuccess: invalidate,
  });
}

export function useCreatePriceListItem(): UseMutationResult<
  { id: string },
  Error,
  { versionId: string; input: PriceListItemEditorInput }
> {
  const invalidate = useInvalidatePriceLists();
  return useMutation({
    mutationFn: (variables: { versionId: string; input: PriceListItemEditorInput }) =>
      api.post<{ id: string }>(`/price-lists/${variables.versionId}/items`, variables.input),
    onSuccess: invalidate,
  });
}

export function useUpdatePriceListItem(): UseMutationResult<
  { id: string },
  Error,
  { itemId: string; input: PriceListItemEditorInput }
> {
  const invalidate = useInvalidatePriceLists();
  return useMutation({
    mutationFn: (variables: { itemId: string; input: PriceListItemEditorInput }) =>
      api.patch<{ id: string }>(`/price-list-items/${variables.itemId}`, variables.input),
    onSuccess: invalidate,
  });
}

export function useDeactivatePriceListItem(): UseMutationResult<
  { id: string; isActive: boolean },
  Error,
  string
> {
  const invalidate = useInvalidatePriceLists();
  return useMutation({
    mutationFn: (itemId: string) =>
      api.post<{ id: string; isActive: boolean }>(`/price-list-items/${itemId}/deactivate`, {}),
    onSuccess: invalidate,
  });
}

export function useWorkCategories(): UseQueryResult<WorkCategoryOption[]> {
  return useQuery<WorkCategoryOption[], Error>({
    queryKey: ['dictionaries', 'work-categories'],
    queryFn: () => api.get<WorkCategoryOption[]>('/work-categories'),
    staleTime: DICTIONARY_STALE_TIME,
  });
}

export function useStoneTypes(): UseQueryResult<StoneTypeOption[]> {
  return useQuery<StoneTypeOption[], Error>({
    queryKey: ['dictionaries', 'stone-types'],
    queryFn: () => api.get<StoneTypeOption[]>('/stone-types'),
    staleTime: DICTIONARY_STALE_TIME,
  });
}

export function useWorkshops(): UseQueryResult<WorkshopOption[], Error> {
  return useQuery<WorkshopOption[], Error>({
    queryKey: ['dictionaries', 'workshops'],
    queryFn: () => api.get<WorkshopOption[]>('/workshops'),
    staleTime: DICTIONARY_STALE_TIME,
  });
}

/**
 * Поиск клиента по телефону или ФИО (ТЗ п. 2.4).
 *
 * Запрос выполняется только от 3 символов: на один-два символа поиск вернул бы
 * почти всю базу, и это была бы и бесполезная нагрузка, и утечка данных.
 * `placeholderData` сохраняет предыдущий список во время набора — без него
 * таблица результатов «мигала» бы пустотой на каждое нажатие клавиши.
 */
export function useCustomerSearch(term: string): UseQueryResult<CustomerSearchItem[]> {
  const trimmed = term.trim();

  return useQuery<CustomerSearchItem[], Error>({
    queryKey: ['customers', 'search', trimmed],
    queryFn: () =>
      api.get<CustomerSearchItem[]>(`/customers/search?q=${encodeURIComponent(trimmed)}`),
    enabled: trimmed.length >= 3,
    placeholderData: (previous) => previous,
  });
}

/** Создать клиента. */
export function useCreateCustomer(): UseMutationResult<CustomerDetail, Error, CustomerInput> {
  const queryClient = useQueryClient();

  return useMutation<CustomerDetail, Error, CustomerInput>({
    mutationFn: (input: CustomerInput) => api.post<CustomerDetail>('/customers', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (error: Error) => {
      // Тост не показываем здесь: мастер сам решает, как показать конфликт
      // (предложить выбрать существующего клиента вместо создания дубля).
      void error;
    },
  });
}

export interface CreateOrderVariables {
  createdStoreId: string;
  pickupStoreId: string;
  workshopId?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  description?: string;
  requiresPrepayment: boolean;
  prepaymentRequiredMinor: number;
  items: {
    name: string;
    metal?: string;
    weightGram?: number;
    size?: string;
    hallmark?: string;
    defects?: string;
    completeness?: string;
  }[];
  works: {
    priceListItemId?: string;
    code: string;
    name: string;
    quantity: number;
    unit: string;
    unitPriceMinor: number;
    durationHours?: number;
    warrantyMonths: number;
    isCustom: boolean;
  }[];
  customerId?: string;
  customer?: CustomerInput;
  /*
   * Признак гарантийного заказа и ссылка на исходный заказ (ТЗ п. 2.9). Заказ
   * создаётся по рекламации: работа выполняется бесплатно, но должна быть
   * связана с заказом, из-за которого возник гарантийный случай, — иначе
   * история разрывается и доказать, что ремонт был гарантийным, нечем.
   */
  isWarranty?: boolean;
  parentOrderId?: string;
}

/** Создать заказ. */
export function useCreateOrder(): UseMutationResult<
  CreatedOrderResponse,
  Error,
  CreateOrderVariables
> {
  const queryClient = useQueryClient();

  return useMutation<CreatedOrderResponse, Error, CreateOrderVariables>({
    mutationFn: (input: CreateOrderVariables) => api.post<CreatedOrderResponse>('/orders', input),
    onSuccess: () => {
      // Список заказов и счётчики дашборда изменились: новый заказ виден и там.
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
    onError: (error: Error) => {
      void error;
    },
  });
}

// ---------------------------------------------------------------------------
// Администрирование: учётные записи и роли (задача 1.2.4)
// ---------------------------------------------------------------------------

/** Ключи кэша учётных записей. */
export const userKeys = {
  all: ['users'] as const,
  list: (filters: UserFilters) => ['users', 'list', filters] as const,
  detail: (id: string) => ['users', 'detail', id] as const,
  rolesCatalog: ['users', 'roles-catalog'] as const,
  /** Сотрудники для экрана входа. Отдельный ключ: список зависит не от фильтров,
   *  а от состояния учётных записей, и общий ключ с `users/list` приводил бы к
   *  лишним перезапросам. */
  loginOptions: ['auth', 'login-options'] as const,
};

/** Список учётных записей с фильтрами (`GET /users`). */
export function useUsers(filters: UserFilters): UseQueryResult<UserListItem[]> {
  return useQuery<UserListItem[], Error>({
    queryKey: userKeys.list(filters),
    queryFn: () =>
      api.get<UserListItem[]>(
        `/users${buildQuery({ q: filters.q, isActive: filters.isActive, role: filters.role })}`,
      ),
  });
}

/** Карточка учётной записи (`GET /users/:id`). */
export function useUser(id: string | null): UseQueryResult<UserDetail> {
  return useQuery<UserDetail, Error>({
    queryKey: userKeys.detail(id ?? ''),
    // `enabled` — потому что хук вызывается до того, как выбрана запись:
    // без него запрос уходил бы на `/users/` с пустым идентификатором.
    enabled: id !== null && id !== '',
    queryFn: () => api.get<UserDetail>(`/users/${id ?? ''}`),
  });
}

/**
 * Справочник ролей (`GET /users/roles-catalog`).
 *
 * `staleTime` бесконечный: матрица прав задана в коде доменного пакета и не
 * меняется во время работы приложения, поэтому перезапрашивать её незачем.
 */
/**
 * Сотрудники для выпадающего списка на экране входа (`GET /auth/login-options`).
 *
 * `retry: false` и `staleTime: Infinity` здесь не случайны:
 *  * повторять запрос при отказе незачем — это запрос к публичному маршруту без
 *    параметров, и повтор вернёт тот же результат, только с задержкой;
 *  * список меняется только администратором, а экран входа открывается заново
 *    при каждой загрузке страницы, поэтому кэш живёт до перезагрузки.
 *
 * Отказ НЕ блокирует вход: экран входа при недоступном списке показывает обычное
 * поле почты, чтобы сбой одного запроса не запрещал войти всем.
 */
export function useLoginOptions(): UseQueryResult<LoginOption[]> {
  return useQuery<LoginOption[], Error>({
    queryKey: userKeys.loginOptions,
    queryFn: () => api.get<LoginOption[]>('/auth/login-options', { noRedirect: true }),
    staleTime: Infinity,
    retry: false,
  });
}

/** Справочник ролей и областей видимости. */
export function useRolesCatalog(): UseQueryResult<RolesCatalog> {
  return useQuery<RolesCatalog, Error>({
    queryKey: userKeys.rolesCatalog,
    queryFn: () => api.get<RolesCatalog>('/users/roles-catalog'),
    staleTime: Infinity,
  });
}

/** Создать учётную запись. */
export function useCreateUser(): UseMutationResult<UserDetail, Error, UserCreateInput> {
  const queryClient = useQueryClient();
  return useMutation<UserDetail, Error, UserCreateInput>({
    mutationFn: (input: UserCreateInput) => api.post<UserDetail>('/users', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userKeys.all });
    },
    onError: (error: Error) => {
      void error;
    },
  });
}

/** Изменить учётную запись. */
export function useUpdateUser(): UseMutationResult<
  UserDetail,
  Error,
  { id: string; input: UserUpdateInput }
> {
  const queryClient = useQueryClient();
  return useMutation<UserDetail, Error, { id: string; input: UserUpdateInput }>({
    mutationFn: ({ id, input }) => api.patch<UserDetail>(`/users/${id}`, input),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: userKeys.all });
      // Карточка обновляется отдельно: список и карточка кэшируются разными
      // ключами, и без этого изменения были бы видны только в списке.
      void queryClient.invalidateQueries({ queryKey: userKeys.detail(user.id) });
    },
    onError: (error: Error) => {
      void error;
    },
  });
}

/** Назначить роль. */
export function useAssignRole(): UseMutationResult<
  UserDetail,
  Error,
  { id: string; role: string; storeId?: string; scope?: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    UserDetail,
    Error,
    { id: string; role: string; storeId?: string; scope?: string }
  >({
    mutationFn: ({ id, ...input }) => api.post<UserDetail>(`/users/${id}/roles`, input),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: userKeys.all });
      void queryClient.invalidateQueries({ queryKey: userKeys.detail(user.id) });
    },
    onError: (error: Error) => {
      void error;
    },
  });
}

/**
 * Снять роль.
 *
 * `roleId` — идентификатор назначения (`user_role.id`), а не код роли: одна
 * роль может быть назначена в нескольких магазинах.
 */
export function useRevokeRole(): UseMutationResult<
  UserDetail,
  Error,
  { id: string; roleId: string }
> {
  const queryClient = useQueryClient();
  return useMutation<UserDetail, Error, { id: string; roleId: string }>({
    mutationFn: ({ id, roleId }) => api.delete<UserDetail>(`/users/${id}/roles/${roleId}`),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: userKeys.all });
      void queryClient.invalidateQueries({ queryKey: userKeys.detail(user.id) });
    },
    onError: (error: Error) => {
      void error;
    },
  });
}

/**
 * Сбросить пароль.
 *
 * Ответ 204 без тела, поэтому тип `void`. После сброса все сессии сотрудника
 * завершаются, и он войдёт только с новым паролем.
 */
export function useResetUserPassword(): UseMutationResult<
  void,
  Error,
  { id: string; newPassword: string }
> {
  return useMutation<void, Error, { id: string; newPassword: string }>({
    mutationFn: ({ id, newPassword }) =>
      api.post<void>(`/users/${id}/reset-password`, { newPassword, mustChangePassword: true }),
    onError: (error: Error) => {
      void error;
    },
  });
}

// ---------------------------------------------------------------------------
// Справочники: администрирование (задача 1.3.1)
// ---------------------------------------------------------------------------

/**
 * Ключи кэша справочников.
 *
 * `all` намеренно совпадает с префиксом ключей для форм заказа
 * (`['dictionaries', ...]`): после создания или правки записи инвалидируется
 * весь раздел, и выпадающие списки в мастере приёма получают свежие данные
 * без отдельной ручной синхронизации.
 */
export const dictionaryKeys = {
  all: ['dictionaries'] as const,
};

/** Список записей справочника: меняется редко, но после правки — сразу. */
const DICTIONARY_ADMIN_STALE_TIME = 5 * 60 * 1000;

/** Создать хук списка: пять справочников отличаются только типом и путём. */
function useDictionaryList<T>(key: string, path: string): UseQueryResult<T[], Error> {
  return useQuery<T[], Error>({
    queryKey: [...dictionaryKeys.all, key],
    queryFn: () => api.get<T[]>(path),
    staleTime: DICTIONARY_ADMIN_STALE_TIME,
  });
}

/**
 * Создать хук изменения: `POST` без идентификатора и `PATCH` с ним.
 *
 * Общая фабрика, а не десять почти одинаковых функций: различается только путь,
 * а логика инвалидации обязана быть одинаковой. Иначе легко забыть сбросить
 * кэш в одном из пяти справочников, и администратор видел бы старые данные
 * до перезагрузки страницы.
 */
function useDictionaryMutation<T, I>(
  method: 'create' | 'update',
  path: string,
): UseMutationResult<T, Error, { id?: string; input: I }> {
  const queryClient = useQueryClient();
  return useMutation<T, Error, { id?: string; input: I }>({
    mutationFn: ({ id, input }) =>
      method === 'create' ? api.post<T>(path, input) : api.patch<T>(`${path}/${String(id)}`, input),
    onSuccess: () => {
      // Инвалидируется весь раздел: справочники связаны между собой (например,
      // исполнитель ссылается на цех), и точечная инвалидация оставила бы
      // согласованность на усмотрение вызывающего кода.
      void queryClient.invalidateQueries({ queryKey: dictionaryKeys.all });
    },
  });
}

export const useAdminStores = (): UseQueryResult<StoreAdminItem[], Error> =>
  useDictionaryList<StoreAdminItem>('stores', '/stores');
export const useAdminWorkshops = (): UseQueryResult<WorkshopAdminItem[], Error> =>
  useDictionaryList<WorkshopAdminItem>('workshops', '/workshops');
export const useAdminPerformers = (): UseQueryResult<PerformerAdminItem[], Error> =>
  useDictionaryList<PerformerAdminItem>('performers', '/performers');
export const useAdminWorkCategories = (): UseQueryResult<WorkCategoryAdminItem[], Error> =>
  useDictionaryList<WorkCategoryAdminItem>('work-categories', '/work-categories');
export const useAdminStoneTypes = (): UseQueryResult<StoneTypeAdminItem[], Error> =>
  useDictionaryList<StoneTypeAdminItem>('stone-types', '/stone-types');

export const useCreateStore = (): UseMutationResult<
  StoreAdminItem,
  Error,
  { id?: string; input: StoreAdminInput }
> => useDictionaryMutation<StoreAdminItem, StoreAdminInput>('create', '/stores');
export const useUpdateStore = (): UseMutationResult<
  StoreAdminItem,
  Error,
  { id?: string; input: StoreAdminInput }
> => useDictionaryMutation<StoreAdminItem, StoreAdminInput>('update', '/stores');

export const useCreateWorkshop = (): UseMutationResult<
  WorkshopAdminItem,
  Error,
  { id?: string; input: WorkshopAdminInput }
> => useDictionaryMutation<WorkshopAdminItem, WorkshopAdminInput>('create', '/workshops');
export const useUpdateWorkshop = (): UseMutationResult<
  WorkshopAdminItem,
  Error,
  { id?: string; input: WorkshopAdminInput }
> => useDictionaryMutation<WorkshopAdminItem, WorkshopAdminInput>('update', '/workshops');

export const useCreatePerformer = (): UseMutationResult<
  PerformerAdminItem,
  Error,
  { id?: string; input: PerformerAdminInput }
> => useDictionaryMutation<PerformerAdminItem, PerformerAdminInput>('create', '/performers');
export const useUpdatePerformer = (): UseMutationResult<
  PerformerAdminItem,
  Error,
  { id?: string; input: PerformerAdminInput }
> => useDictionaryMutation<PerformerAdminItem, PerformerAdminInput>('update', '/performers');

export const useCreateWorkCategory = (): UseMutationResult<
  WorkCategoryAdminItem,
  Error,
  { id?: string; input: WorkCategoryAdminInput }
> =>
  useDictionaryMutation<WorkCategoryAdminItem, WorkCategoryAdminInput>(
    'create',
    '/work-categories',
  );
export const useUpdateWorkCategory = (): UseMutationResult<
  WorkCategoryAdminItem,
  Error,
  { id?: string; input: WorkCategoryAdminInput }
> =>
  useDictionaryMutation<WorkCategoryAdminItem, WorkCategoryAdminInput>(
    'update',
    '/work-categories',
  );

export const useCreateStoneType = (): UseMutationResult<
  StoneTypeAdminItem,
  Error,
  { id?: string; input: StoneTypeAdminInput }
> => useDictionaryMutation<StoneTypeAdminItem, StoneTypeAdminInput>('create', '/stone-types');
export const useUpdateStoneType = (): UseMutationResult<
  StoneTypeAdminItem,
  Error,
  { id?: string; input: StoneTypeAdminInput }
> => useDictionaryMutation<StoneTypeAdminItem, StoneTypeAdminInput>('update', '/stone-types');

// ---------------------------------------------------------------------------
// Рабочий календарь (задача 1.3.3)
// ---------------------------------------------------------------------------

/** Ключ раздела календаря — отдельно от справочников: права и данные разные. */
export const calendarKeys = {
  all: ['working-calendar'] as const,
  list: (from: string, to: string) => ['working-calendar', 'list', from, to] as const,
  summary: (from: string, to: string) => ['working-calendar', 'summary', from, to] as const,
};

/**
 * Записи-исключения и праздники за период.
 *
 * Период входит в ключ кэша: сроки считаются по конкретному окну, и если бы
 * ключ был общим, переход на другой месяц показывал бы данные предыдущего.
 */
export function useWorkingCalendar(
  from: string,
  to: string,
): UseQueryResult<CalendarListResponse, Error> {
  return useQuery<CalendarListResponse, Error>({
    queryKey: calendarKeys.list(from, to),
    queryFn: () => api.get<CalendarListResponse>(`/working-calendar?from=${from}&to=${to}`),
    staleTime: DICTIONARY_ADMIN_STALE_TIME,
  });
}

/** Сводка по месяцам: рабочие дни и праздники. */
export function useCalendarSummary(
  from: string,
  to: string,
): UseQueryResult<CalendarMonthSummary[], Error> {
  return useQuery<CalendarMonthSummary[], Error>({
    queryKey: calendarKeys.summary(from, to),
    queryFn: () =>
      api.get<CalendarMonthSummary[]>(`/working-calendar/summary?from=${from}&to=${to}`),
    staleTime: DICTIONARY_ADMIN_STALE_TIME,
  });
}

/** Общая инвалидация календаря: записи и сводка обязаны сброситься вместе. */
function useCalendarInvalidate(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
  };
}

export function useCreateCalendarDay(): UseMutationResult<
  CalendarDayItem,
  Error,
  { input: CalendarDayInput }
> {
  const invalidate = useCalendarInvalidate();
  return useMutation<CalendarDayItem, Error, { input: CalendarDayInput }>({
    mutationFn: ({ input }) => api.post<CalendarDayItem>('/working-calendar', input),
    onSuccess: invalidate,
  });
}

export function useUpdateCalendarDay(): UseMutationResult<
  CalendarDayItem,
  Error,
  { id: string; input: CalendarDayInput }
> {
  const invalidate = useCalendarInvalidate();
  return useMutation<CalendarDayItem, Error, { id: string; input: CalendarDayInput }>({
    mutationFn: ({ id, input }) => api.patch<CalendarDayItem>(`/working-calendar/${id}`, input),
    onSuccess: invalidate,
  });
}

/**
 * Снять отметку — день возвращается к обычному правилу.
 *
 * Здесь `DELETE` впервые в системе администратора, и это осознанно: на строку
 * календаря не ссылается ни одна таблица, а «отключить дату» смысла не имеет.
 * Прежнее значение сохраняется в журнале действий, поэтому действие обратимо.
 */
export function useDeleteCalendarDay(): UseMutationResult<
  { removed: true },
  Error,
  { id: string }
> {
  const invalidate = useCalendarInvalidate();
  return useMutation<{ removed: true }, Error, { id: string }>({
    mutationFn: ({ id }) => api.delete<{ removed: true }>(`/working-calendar/${id}`),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Нормативы этапов (задача 1.3.4, ТЗ п. 2.7)
// ---------------------------------------------------------------------------

export const normKeys = {
  all: ['stage-norms'] as const,
  current: () => ['stage-norms', 'current'] as const,
  versions: () => ['stage-norms', 'versions'] as const,
};

/** Действующая версия нормативов. `null` — нормативы не заданы. */
export function useCurrentNorms(): UseQueryResult<NormVersion | null, Error> {
  return useQuery<NormVersion | null, Error>({
    queryKey: normKeys.current(),
    queryFn: () => api.get<NormVersion | null>('/stage-norms'),
    staleTime: DICTIONARY_ADMIN_STALE_TIME,
  });
}

/**
 * История версий.
 *
 * Возвращаются все версии, а не только действующая: смысл истории в том, чтобы
 * объяснить срок уже принятого заказа.
 */
export function useNormVersions(): UseQueryResult<NormVersion[], Error> {
  return useQuery<NormVersion[], Error>({
    queryKey: normKeys.versions(),
    queryFn: () => api.get<NormVersion[]>('/stage-norms/versions'),
    staleTime: DICTIONARY_ADMIN_STALE_TIME,
  });
}

/**
 * Создать новую версию нормативов.
 *
 * Инвалидируется всё семейство ключей: новая версия меняет и действующий набор,
 * и историю, а рассинхронизация показала бы администратору старые значения.
 */
export function useCreateNormVersion(): UseMutationResult<
  NormVersion,
  Error,
  CreateNormVersionInput
> {
  const queryClient = useQueryClient();
  return useMutation<NormVersion, Error, CreateNormVersionInput>({
    mutationFn: (input) => api.post<NormVersion>('/stage-norms/versions', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: normKeys.all });
    },
  });
}

/**
 * Доставки курьера (задача 2.7).
 *
 * `staleTime` увеличен: список меняется действиями самого курьера, а не
 * поминутно, и перезапрос при каждом возврате на экран на телефоне с плохой
 * связью только тратил бы трафик и показывал мигание.
 */
export function useMyDeliveries(enabled: boolean): UseQueryResult<Batch[], Error> {
  return useQuery<Batch[], Error>({
    queryKey: batchKeys.myDeliveries(),
    queryFn: () => api.get<Batch[]>('/batches/my-deliveries'),
    enabled,
    staleTime: 30_000,
  });
}

/** Партия с составом. */
export function useBatch(id: string): UseQueryResult<BatchDetail, Error> {
  return useQuery<BatchDetail, Error>({
    queryKey: batchKeys.detail(id),
    queryFn: () => api.get<BatchDetail>(`/batches/${id}`),
    enabled: id !== '',
  });
}

/**
 * Найти партию по отсканированному коду.
 *
 * Отправляется ровно то, что прочитал сканер: разбор (`repair://…`, перевод
 * строки, регистр) выполняется на сервере, где правила уже описаны и покрыты
 * тестами. Дублирование разбора на клиенте дало бы две реализации, которые
 * разошлись бы при первой же правке.
 */
export async function findBatchByScan(code: string): Promise<BatchDetail> {
  return api.get<BatchDetail>(`/batches/scan${buildQuery({ code })}`);
}

// ---------------------------------------------------------------------------
// Раздел партий (задача 7.6)
// ---------------------------------------------------------------------------

/**
 * Список партий с фильтрами.
 *
 * `enabled` зависит от права `logistics:read`: без него маршрут вернёт 403, а
 * показывать сотруднику ошибку доступа там, где раздела просто нет в меню,
 * незачем.
 */
export function useBatches(
  filters: Record<string, string>,
  enabled: boolean,
): UseQueryResult<{ items: Batch[]; nextCursor: string | null }, Error> {
  return useQuery<{ items: Batch[]; nextCursor: string | null }, Error>({
    queryKey: batchKeys.list(filters),
    queryFn: () =>
      api.get<{ items: Batch[]; nextCursor: string | null }>(`/batches${buildQuery(filters)}`),
    enabled,
  });
}

/** Кандидаты для включения в партию: подходящие и отклонённые с причинами. */
export function useBatchCandidates(
  id: string,
  enabled: boolean,
): UseQueryResult<BatchCandidateGroup, Error> {
  return useQuery<BatchCandidateGroup, Error>({
    queryKey: batchKeys.candidates(id),
    queryFn: () => api.get<BatchCandidateGroup>(`/batches/${id}/candidates`),
    enabled: id !== '' && enabled,
  });
}

/** Создать партию (возможно, сразу с составом). */
export function useCreateBatch(): UseMutationResult<BatchDetail, Error, Record<string, unknown>> {
  const queryClient = useQueryClient();
  return useMutation<BatchDetail, Error, Record<string, unknown>>({
    mutationFn: (input) => api.post<BatchDetail>('/batches', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: batchKeys.all });
    },
  });
}

/** Добавить заказы в партию. */
export function useAddBatchOrders(): UseMutationResult<
  BatchDetail,
  Error,
  { id: string; orderIds: string[] }
> {
  const queryClient = useQueryClient();
  return useMutation<BatchDetail, Error, { id: string; orderIds: string[] }>({
    mutationFn: ({ id, orderIds }) => api.post<BatchDetail>(`/batches/${id}/orders`, { orderIds }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: batchKeys.detail(variables.id) });
      void queryClient.invalidateQueries({ queryKey: batchKeys.candidates(variables.id) });
      void queryClient.invalidateQueries({ queryKey: batchKeys.all });
    },
  });
}

/** Убрать заказ из партии — причина обязательна. */
export function useRemoveBatchOrder(): UseMutationResult<
  BatchDetail,
  Error,
  { id: string; orderId: string; reason: string }
> {
  const queryClient = useQueryClient();
  return useMutation<BatchDetail, Error, { id: string; orderId: string; reason: string }>({
    mutationFn: ({ id, orderId, reason }) =>
      api.delete<BatchDetail>(`/batches/${id}/orders/${orderId}`, { reason }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: batchKeys.detail(variables.id) });
      void queryClient.invalidateQueries({ queryKey: batchKeys.candidates(variables.id) });
      void queryClient.invalidateQueries({ queryKey: batchKeys.all });
    },
  });
}

/**
 * Сформировать акт по партии.
 *
 * После этого состав менять нельзя: акт — документ о передаче конкретных
 * изделий, и добавление заказа после его формирования сделало бы бумагу
 * несоответствующей факту.
 */
export function useFormBatchAct(): UseMutationResult<BatchDetail, Error, string> {
  const queryClient = useQueryClient();
  return useMutation<BatchDetail, Error, string>({
    mutationFn: (id) => api.post<BatchDetail>(`/batches/${id}/act`, {}),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: batchKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: batchKeys.all });
    },
  });
}

/** Отправить или принять партию (`phase`: `dispatch` | `receive`). */
export function useBatchPhaseAction(): UseMutationResult<
  BatchDetail,
  Error,
  { id: string; phase: 'dispatch' | 'receive' }
> {
  const queryClient = useQueryClient();
  return useMutation<BatchDetail, Error, { id: string; phase: 'dispatch' | 'receive' }>({
    mutationFn: ({ id, phase }) => api.post<BatchDetail>(`/batches/${id}/${phase}`, {}),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: batchKeys.detail(variables.id) });
      void queryClient.invalidateQueries({ queryKey: batchKeys.all });
      /*
       * Партия переводит СТАТУСЫ ЗАКАЗОВ, поэтому списки и сводка заказов
       * устарели. Без сброса сотрудник увидел бы партию «в пути», а заказы в
       * ней — в прежнем статусе, и решил бы, что операция не сработала.
       */
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

/** Подписать акт со стороны отправителя или получателя. */
export function useSignBatchAct(): UseMutationResult<
  BatchDetail,
  Error,
  { id: string; side: 'FROM' | 'TO' }
> {
  const queryClient = useQueryClient();
  return useMutation<BatchDetail, Error, { id: string; side: 'FROM' | 'TO' }>({
    mutationFn: ({ id, side }) => api.post<BatchDetail>(`/batches/${id}/act/sign`, { side }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: batchKeys.detail(variables.id) });
    },
  });
}

/**
 * Приложить подпись клиента о получении изделия (дефект 66).
 *
 * Отдельная мутация, а не часть перехода: подпись — это файл, а переход
 * отправляется JSON. Разделение обязательно ещё и потому, что переход охраняется
 * условием `PICKUP_SIGNATURE`: если бы подпись загружалась ПОСЛЕ перехода,
 * сервер отклонил бы сам переход, и выдача осталась бы невыполнимой.
 */
export function useUploadPickupSignature(): UseMutationResult<
  { orderId: string; fileId: string },
  Error,
  { orderId: string; file: File }
> {
  const queryClient = useQueryClient();
  return useMutation<{ orderId: string; fileId: string }, Error, { orderId: string; file: File }>({
    mutationFn: ({ orderId, file }) => {
      const form = new FormData();
      form.append('file', file);
      return api.postForm<{ orderId: string; fileId: string }>(
        `/orders/${orderId}/pickup-signature`,
        form,
      );
    },
    onSuccess: (_data, variables) => {
      // Карточка хранит признак наличия подписи: без сброса кэша интерфейс
      // по-прежнему считал бы её отсутствующей и не предложил бы выдачу.
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(variables.orderId) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    },
  });
}

/** Добавляемая работа: либо позиция прейскуранта, либо нетиповая с ценой. */
export interface OrderWorkInput {
  itemId?: string;
  priceListItemId?: string;
  code?: string;
  name?: string;
  quantity?: number;
  unit?: string;
  unitPriceMinor?: number;
  durationHours?: number;
  warrantyMonths?: number;
  isCustom?: boolean;
  comment?: string;
}

/** Правка существующей работы. `version` — оптимистичная блокировка. */
export interface OrderWorkPatchInput {
  version: number;
  quantity?: number;
  unitPriceMinor?: number;
  name?: string;
  unit?: string;
  durationHours?: number;
  warrantyMonths?: number;
  comment?: string;
}

/**
 * Исполнители производства для выбора в карточке заказа.
 *
 * Только активные: архивный исполнитель в списке выбора — это возможность
 * выдать работу человеку, который её не выполнит, и узнать об этом постфактум.
 * Фильтр по цеху задаётся, когда цех заказа известен: подсказывать ювелира из
 * другого цеха бессмысленно — изделие физически не там.
 */
export function usePerformers(workshopId?: string): UseQueryResult<PerformerOption[], Error> {
  return useQuery<PerformerOption[], Error>({
    queryKey: ['dictionaries', 'performers', workshopId ?? 'all'],
    queryFn: () =>
      api.get<PerformerOption[]>(
        `/performers?isActive=true${workshopId !== undefined && workshopId !== '' ? `&workshopId=${encodeURIComponent(workshopId)}` : ''}`,
      ),
    staleTime: DICTIONARY_STALE_TIME,
  });
}

/**
 * Выдать работу исполнителю (задача 7.2).
 *
 * Ответ — карточка заказа целиком: назначение меняет и статус, и список
 * назначений, и доступные переходы. Собирать новое состояние из ответа
 * назначения значило бы оставить в карточке устаревший статус.
 */
export function useAssignPerformer(): UseMutationResult<
  OrderAssignment,
  Error,
  { orderId: string; performerId: string; plannedHours?: number; comment?: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    /*
     * Маршрут возвращает НАЗНАЧЕНИЕ, а не карточку заказа, — но меняет и статус
     * заказа, и его доступные переходы, и ленту событий. Поэтому кэш карточки
     * СБРАСЫВАЕТСЯ, а не подменяется ответом.
     *
     * Здесь был дефект: ответ назначения писался в кэш карточки по ключу
     * `order.id`, но у назначения `id` — это идентификатор НАЗНАЧЕНИЯ, а не
     * заказа. Кэш карточки не обновлялся вовсе (и рядом появлялась мусорная
     * запись по чужому ключу), поэтому сотрудник видел старое состояние, пока
     * не перезагрузит страницу вручную.
     */
    mutationFn: (variables) =>
      api.post<OrderAssignment>(`/orders/${variables.orderId}/assignments`, {
        performerId: variables.performerId,
        plannedHours: variables.plannedHours,
        comment: variables.comment,
      }),
    onSuccess: (_assignment, variables) => invalidateOrderCard(queryClient, variables.orderId),
  });
}

/** Принять работу у исполнителя: назначение закрывается, заказ идёт дальше. */
export function useFinishAssignment(): UseMutationResult<
  OrderAssignment,
  Error,
  { orderId: string; assignmentId: string; comment?: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    // Возвращается назначение; карточка заказа сбрасывается — см.
    // `useAssignPerformer` о том же.
    mutationFn: (variables) =>
      api.post<OrderAssignment>(
        `/orders/${variables.orderId}/assignments/${variables.assignmentId}/finish`,
        { comment: variables.comment },
      ),
    onSuccess: (_assignment, variables) => invalidateOrderCard(queryClient, variables.orderId),
  });
}

/**
 * Добавить работу в заказ (требование заказчика).
 *
 * Сервер возвращает карточку целиком, и это важно: правка состава меняет итог
 * заказа, а вместе с ним — состояние согласования. Обновлять только список
 * работ значило бы показать старую сумму и не предупредить, что согласование
 * придётся получать заново.
 */
export function useAddOrderWork(): UseMutationResult<
  OrderDetail,
  Error,
  { orderId: string; input: OrderWorkInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables) =>
      api.post<OrderDetail>(`/orders/${variables.orderId}/works`, variables.input),
    onSuccess: (order) => queryClient.setQueryData(orderKeys.detail(order.id), order),
  });
}

/** Изменить работу: количество, цену, название, гарантию. */
export function useUpdateOrderWork(): UseMutationResult<
  OrderDetail,
  Error,
  { orderId: string; workId: string; input: OrderWorkPatchInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables) =>
      api.patch<OrderDetail>(
        `/orders/${variables.orderId}/works/${variables.workId}`,
        variables.input,
      ),
    onSuccess: (order) => queryClient.setQueryData(orderKeys.detail(order.id), order),
  });
}

/** Удалить работу из заказа. Причина обязательна: это изменение суммы. */
export function useRemoveOrderWork(): UseMutationResult<
  OrderDetail,
  Error,
  { orderId: string; workId: string; version: number; reason: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables) =>
      api.delete<OrderDetail>(`/orders/${variables.orderId}/works/${variables.workId}`, {
        version: variables.version,
        reason: variables.reason,
      }),
    onSuccess: (order) => queryClient.setQueryData(orderKeys.detail(order.id), order),
  });
}

/**
 * Состояния заказа, доступные для отката (инструмент администратора).
 *
 * Список приходит с СЕРВЕРА, а не выводится из истории на клиенте: какие
 * состояния достижимы, зависит от текущего статуса и терминальности заказа, и
 * своя копия правила разошлась бы с сервером — интерфейс предлагал бы откат,
 * который сервер отклонит.
 */
export function useRollbackStates(
  orderId: string,
  enabled: boolean,
): UseQueryResult<{ currentStatus: string; isFinal: boolean; states: string[] }, Error> {
  return useQuery({
    queryKey: ['orders', 'rollback-states', orderId],
    queryFn: () =>
      api.get<{ currentStatus: string; isFinal: boolean; states: string[] }>(
        `/orders/${orderId}/rollback-states`,
      ),
    enabled,
    staleTime: 0,
  });
}

/**
 * Откатить заказ до состояния из истории (только администратор).
 *
 * Ответ — карточка заказа целиком, поэтому кэш обновляется ею же: статус,
 * доступные переходы и история меняются все сразу.
 */
export function useOrderRollback(): UseMutationResult<
  OrderDetail,
  Error,
  { orderId: string; toStatus: string; reason: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables) =>
      api.post<OrderDetail>(`/orders/${variables.orderId}/rollback`, {
        toStatus: variables.toStatus,
        reason: variables.reason,
      }),
    onSuccess: (order) => {
      queryClient.setQueryData(orderKeys.detail(order.id), order);
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(order.id) });
      void queryClient.invalidateQueries({ queryKey: orderKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'rollback-states', order.id] });
    },
  });
}
