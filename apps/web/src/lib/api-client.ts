/**
 * HTTP-клиент для обращения к API.
 *
 * Особенности:
 *  * токены живут в httpOnly-cookie — клиент их не видит и не хранит;
 *  * при 401 автоматически пробуем обновить токен и повторить запрос;
 *  * ошибки API приводятся к единому виду с машиночитаемым кодом
 *    (docs/07-api-spec.md §1.1), на который ориентируется интерфейс.
 */

export interface ApiError {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const BASE_URL = '/api/v1';

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Не пытаться обновлять токен (используется для самих auth-запросов). */
  skipRefresh?: boolean;
  /**
   * Не перенаправлять на `/login` при неудачном обновлении.
   *
   * Нужно при проверке сессии на старте: если пользователь не вошёл, запрос
   * к `/auth/me` возвращает 401, и безусловный переход на `/login` приводил бы
   * к перезагрузке той же страницы входа по кругу.
   */
  noRedirect?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipRefresh, noRedirect, headers, ...rest } = options;

  const response = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Cookie отправляются и принимаются автоматически, в пределах своего origin.
    credentials: 'same-origin',
  });

  // Access-токен истёк — обновляем и повторяем ОДИН раз.
  if (response.status === 401 && !skipRefresh) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return request<T>(path, { ...options, skipRefresh: true });
    }
    // Обновить не удалось — сессия действительно закончилась.
    if (!noRedirect && typeof window !== 'undefined') {
      window.location.href = '/login';
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = (data ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(
      response.status,
      error.code ?? 'UNKNOWN_ERROR',
      error.message ?? 'Произошла ошибка при обращении к серверу',
      error.details,
    );
  }

  return data as T;
}

/** Попытка обновить access-токен. Возвращает true при успехе. */
async function tryRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Скачать бинарный ответ (PDF квитанции).
 *
 * Отдельно от `request`, потому что тот разбирает тело как JSON: у PDF тело
 * двоичное, и `response.text()` его испортил бы. Обновление access-токена
 * повторено здесь же — иначе печать «слетала» бы у сотрудника, который
 * задержался на карточке заказа дольше 15 минут, и выглядело бы это как
 * «квитанция не печатается».
 *
 * Ошибка возвращается как объект blob (сервер отдаёт JSON даже для этого
 * маршрута), поэтому вызывающая сторона может показать код и сообщение.
 */
export async function requestBlob(path: string): Promise<Blob> {
  const load = async (): Promise<Response> =>
    fetch(`${BASE_URL}${path}`, { credentials: 'same-origin' });

  let response = await load();

  if (response.status === 401) {
    if (await tryRefresh()) {
      response = await load();
    }
    if (response.status === 401 && typeof window !== 'undefined') {
      window.location.href = '/login';
      throw new ApiRequestError(401, 'UNAUTHORIZED', 'Сессия истекла');
    }
  }

  if (!response.ok) {
    // Тело ошибки — JSON, несмотря на ожидаемый PDF.
    let code = 'UNKNOWN_ERROR';
    let message = 'Не удалось получить файл';
    try {
      const parsed = (await response.json()) as Partial<ApiError>;
      code = parsed.code ?? code;
      message = parsed.message ?? message;
    } catch {
      // Тело не JSON — оставляем общее сообщение.
    }
    throw new ApiRequestError(response.status, code, message);
  }

  return response.blob();
}

/**
 * Сборка query-строки из объекта.
 *
 * Массивы повторяются как несколько параметров с одним именем: так их
 * ожидает `@Query('status')` в Nest при `?status=A&status=B`. Пустые
 * значения пропускаются — иначе сервер получил бы `status=` и попытался
 * разобрать пустой статус.
 *
 * Допустимы только строки, числа, булевы значения и `Date`. Объекты и
 * функции отклоняются с ошибкой: раньше они молча превращались в
 * `[object Object]`, и запрос уходил на сервер с заведомо неверным
 * фильтром — например, «ничего не найдено» вместо результатов.
 */
export function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();

  const appendValue = (key: string, raw: unknown): void => {
    if (raw === undefined || raw === null || raw === '') return;

    if (raw instanceof Date) {
      search.append(key, raw.toISOString());
      return;
    }

    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      search.append(key, String(raw));
      return;
    }

    throw new TypeError(
      `Параметр запроса «${key}» имеет недопустимый тип ${typeof raw}: ` +
        'ожидается строка, число, boolean или Date',
    );
  };

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        appendValue(key, entry);
      }
      continue;
    }

    appendValue(key, value);
  }

  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

/** Типизированные методы API. */
export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),

  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }),

  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),

  /** Загрузка файлов: тело `multipart/form-data`. */
  postForm: <T>(path: string, form: FormData) => postForm<T>(path, form),
};

/**
 * POST с телом `FormData` (загрузка файлов).
 *
 * `Content-Type` НЕ задаётся: браузер сам подставит `multipart/form-data` с
 * boundary. Заданный вручную заголовок boundary не содержит, и сервер не смог
 * бы разобрать тело — файлы «терялись» бы с ошибкой разбора.
 *
 * Обновление access-токена повторено здесь по той же причине, что и в
 * `requestBlob`: загрузка фото с истёкшим токеном иначе просто «не работала бы».
 */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const load = async (): Promise<Response> =>
    fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    });

  let response = await load();

  if (response.status === 401) {
    if (await tryRefresh()) {
      response = await load();
    }
    if (response.status === 401 && typeof window !== 'undefined') {
      window.location.href = '/login';
      throw new ApiRequestError(401, 'UNAUTHORIZED', 'Сессия истекла');
    }
  }

  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = (data ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(
      response.status,
      error.code ?? 'UNKNOWN_ERROR',
      error.message ?? 'Не удалось загрузить файл',
      error.details,
    );
  }

  return data as T;
}

/**
 * Запрос с ключом идемпотентности — обязателен для денежных операций
 * (docs/07-api-spec.md §1.3). Защищает от двойного списания при повторном нажатии.
 */
export function withIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Человекочитаемое описание ошибки для тоста. */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    // Для известных кодов даём понятный текст, а не техническое сообщение.
    const knownMessages: Record<string, string> = {
      PREPAYMENT_REQUIRED: 'Старт работ заблокирован: предоплата не внесена в полном объёме',
      NOT_PAID_IN_FULL: 'Выдача невозможна: заказ оплачен не полностью',
      APPROVAL_MISSING: 'Отсутствует согласование клиента по сумме и сроку',
      CONSENT_REQUIRED: 'Необходимо согласие клиента на запись разговора',
      STALE_VERSION: 'Заказ был изменён другим сотрудником. Обновите страницу.',
      FORBIDDEN_SCOPE: 'Этот заказ вам недоступен',
      INVALID_TRANSITION: 'Такое действие для текущего статуса невозможно',
    };
    return knownMessages[error.code] ?? error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Не удалось выполнить операцию';
}