'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { describeApiError } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';

export default function LoginPage(): ReactNode {
  const { user, loading, login } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Уже вошедшего не заставляем вводить пароль повторно.
  useEffect(() => {
    if (!loading && user !== null) {
      router.replace('/dashboard');
    }
  }, [loading, user, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(email.trim(), password);
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

          <Button type="submit" loading={submitting} className="w-full">
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
