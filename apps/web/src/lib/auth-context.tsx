'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api-client';
import { clearAllDraftsForUser } from '@/lib/draft-autosave';
import { clearServiceWorkerCaches } from '@/components/service-worker-registrar';
import type { AuthenticatedUser, LoginResponse } from '@/lib/api-types';

interface AuthContextValue {
  user: AuthenticatedUser | null;
  /** true, пока идёт первичная проверка сессии — иначе был бы «мигающий» вход. */
  loading: boolean;
  /**
   * Вход по адресу почты.
   *
   * Оставлен для сценариев, где почта известна заранее. Экран входа
   * предпочитает `loginAs` — см. ниже.
   */
  login: (email: string, password: string) => Promise<void>;
  /**
   * Вход по идентификатору сотрудника из выпадающего списка.
   *
   * Идентификатор, а не почта: список на экране входа доступен до
   * аутентификации, поэтому почта в него не отдаётся — иначе она была бы готовым
   * перечнем адресов для фишинга. Сотрудник выбирает себя по имени, а сервер сам
   * находит учётную запись.
   */
  loginAs: (userId: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Проверка права: UI скрывает недоступное, сервер всё равно проверит. */
  can: (permission: string) => boolean;
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Состояние аутентификации.
 *
 * Токены живут в httpOnly-cookie и недоступны скрипту, поэтому единственный
 * способ узнать, вошёл ли пользователь, — запросить `/auth/me`. Пока ответ
 * не получен, `loading = true`: без этого защищённые экраны успевали
 * отрисоваться и «мигали» формой входа.
 */
export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;

    // `noRedirect` обязателен: при отсутствии сессии запрос вернёт 401, и без
    // этого флага браузер уходил бы на `/login` и перезагружал страницу.
    // Обновление токена при этом разрешено — access-токен живёт 15 минут,
    // а refresh 30 дней, и при перезагрузке страницы пользователь не должен
    // оказываться разлогинен.
    api
      .get<AuthenticatedUser>('/auth/me', { noRedirect: true })
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // 401 — обычная ситуация «не вошёл», а не сбой: молча показываем вход.
        if (!(error instanceof ApiRequestError && error.statusCode === 401)) {
          console.error('Не удалось проверить сессию:', error);
        }
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Общая часть обоих видов входа: различается только поле идентификатора.
   * Вынесена, чтобы установка пользователя, очистка кэша и переход не
   * расходились между двумя путями — расхождение здесь означало бы, что после
   * входа одним способом в кэше остаются данные прошлого пользователя.
   */
  const establishSession = useCallback(
    async (credentials: { email: string } | { userId: string }, password: string) => {
      const result = await api.post<LoginResponse>(
        '/auth/login',
        { ...credentials, password },
        { skipRefresh: true },
      );
      setUser(result.user);
      // Данные прошлого пользователя не должны попасть в кэш нового.
      queryClient.clear();
      router.push('/dashboard');
    },
    [queryClient, router],
  );

  const login = useCallback(
    (email: string, password: string) => establishSession({ email }, password),
    [establishSession],
  );

  const loginAs = useCallback(
    (userId: string, password: string) => establishSession({ userId }, password),
    [establishSession],
  );

  const logout = useCallback(async () => {
    try {
      await api.post<void>('/auth/logout', undefined, { skipRefresh: true });
    } finally {
      // Выход выполняем даже при ошибке сети: пользователь нажал «Выйти»,
      // и оставлять его в интерфейсе с чужой сессией недопустимо.
      //
      // Черновики форм удаляются ДО сброса пользователя: они содержат ФИО и
      // телефон клиента (152-ФЗ), а компьютер на точке часто общий. Без этой
      // очистки следующий сотрудник увидел бы предложение восстановить чужой
      // черновик (задача 1.7.3).
      if (user !== null) clearAllDraftsForUser(user.id);
      // Кэш оболочки PWA тоже очищается: правило «выход очищает устройство»
      // должно выполняться целиком (задача 1.7.5).
      clearServiceWorkerCaches();
      setUser(null);
      queryClient.clear();
      router.push('/login');
    }
  }, [queryClient, router, user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login,
      loginAs,
      logout,
      can: (permission: string) => user?.permissions.includes(permission) ?? false,
      hasRole: (role: string) => user?.roles.includes(role) ?? false,
    }),
    [user, loading, login, loginAs, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth используется вне AuthProvider');
  }
  return context;
}
