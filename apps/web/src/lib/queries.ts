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
  PriceListItemOption,
  SearchResultItem,
  StoneTypeOption,
  StoreOption,
  TimelineEntry,
  WorkCategoryOption,
  WorkshopOption,
  RolesCatalog,
  UserCreateInput,
  UserDetail,
  UserFilters,
  UserListItem,
  UserUpdateInput,
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
