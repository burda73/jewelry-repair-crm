'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { describeApiError } from '@/lib/api-client';
import { useLoginOptions } from '@/lib/queries';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';

/**
 * Экран входа.
 *
 * ## Почему выбор сотрудника, а не поле почты
 *
 * Сотрудники входили по почте вида `receiver1@remixgold.ru` — номерной ящик
 * вместо фамилии. Ошибиться в нём легко, а ошибка выглядит как «неверный пароль»:
 * человек считает, что забыл пароль, и идёт его сбрасывать. Выбор по имени убирает
 * этот класс отказов целиком.
 *
 * ## Почта не покидает сервер
 *
 * Список сотрудников доступен ДО входа, поэтому почта в него не отдаётся: она
 * была бы готовым перечнем адресов для фишинга. На сервер уходит `userId`, и
 * учётную запись по нему находит сам сервер. Пароль проверяется как обычно.
 *
 * ## Сбой списка не запирает систему
 *
 * Если запрос списка не удался (сервер перезапускается, сеть недоступна), экран
 * показывает обычное поле почты. Иначе одна упавшая ручка лишала бы входа всех,
 * включая администратора, который эту ручку и починил бы.
 */
export default function LoginPage(): ReactNode {
  const { user, loading, login, loginAs } = useAuth();
  const router = useRouter();
  const optionsQuery = useLoginOptions();

  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = optionsQuery.data ?? [];
  /*
   * Выбор списком — основной режим. Пока список грузится, показываем поле
   * заблокированным, а не подменяем его на почту: иначе при медленной сети поле
   * «мигало» бы между почтой и списком, и сотрудник успел бы начать вводить
   * адрес в поле, которое через мгновение исчезает.
   *
   * При отказе запроса переходим на почту — это и есть резервный вход.
   */
  const optionsLoading = optionsQuery.isLoading;
  const useList = options.length > 0;
  const listFailed = optionsQuery.isError;

  // Уже вошедшего не заставляем вводить пароль повторно.
  useEffect(() => {
    if (!loading && user !== null) {
      router.replace('/dashboard');
    }
  }, [loading, user, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (optionsLoading) return;
    if (useList && userId === '') {
      setError(t.login.chooseEmployee);
      return;
    }

    setSubmitting(true);
    try {
      if (useList) {
        await loginAs(userId, password);
      } else {
        await login(email.trim(), password);
      }
    } catch (caught: unknown) {
      setError(describeApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-label="Загрузка" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-slate-900">{t.app.title}</h1>
          <p className="mt-2 text-sm text-slate-500">{t.login.subtitle}</p>
        </header>

        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          noValidate
        >
          {error !== null ? (
            <div
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          {optionsLoading ? (
            <Field label={t.login.employee} htmlFor="userId" required>
              <Select id="userId" disabled value="">
                <option value="">{t.login.loadingEmployees}</option>
              </Select>
            </Field>
          ) : useList ? (
            <Field label={t.login.employee} htmlFor="userId" required>
              <Select
                id="userId"
                name="userId"
                autoComplete="username"
                required
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                  setError(null);
                }}
                disabled={submitting}
              >
                <option value="">{t.login.chooseEmployee}</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={t.login.email} htmlFor="email" required>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={submitting}
              />
            </Field>
          )}

          <Field label={t.login.password} htmlFor="password" required>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />
          </Field>

          {listFailed ? <p className="text-xs text-slate-500">{t.login.listUnavailable}</p> : null}

          <Button type="submit" loading={submitting} disabled={optionsLoading} className="w-full">
            {submitting ? t.login.submitting : t.login.submit}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-400">
          {t.app.title} · {new Date().getFullYear()}
        </p>
      </div>
    </main>
  );
}
