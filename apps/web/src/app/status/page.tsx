'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api-client';
import type { PublicOrderStatusView } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';

/**
 * Публичная проверка статуса заказа (задача 5.11).
 *
 * ## Зачем отдельная страница вне входа
 *
 * Клиент звонит в магазин с вопросом «готов ли заказ» — это самый частый звонок.
 * Приёмщик отвлекается от работы, а клиент ждёт ответа. Страница закрывает этот
 * вопрос без звонка и без учётной записи.
 *
 * ## Почему два поля, а не одно
 *
 * Номер заказа угадываем: «МСК1-2609-000001» — код магазина, месяц и порядковый
 * номер. Одного номера хватило бы, чтобы посторонний перебором узнал статусы
 * чужих заказов. Поэтому вторым фактором служит код из SMS на телефон клиента.
 *
 * ## Почему страница не показывает, что заказ не найден
 *
 * Сервер отвечает одинаково во всех случаях отказа: «если заказ существует, код
 * отправлен». Страница повторяет это поведение и НЕ различает «нет такого
 * заказа» и «телефон не тот»: иначе перебором номеров можно было бы выяснить,
 * какие заказы есть в системе, — утечка сама по себе, без показа статуса.
 *
 * ## Почему телефон не подставляется из адреса
 *
 * Ни номер заказа, ни телефон не берутся из параметров адреса: ссылка с
 * подставленным номером заказа попала бы в историю браузера и в чужой телефон
 * при передаче ссылки. Клиент вводит оба значения сам.
 */

interface RequestState {
  /** Код отправлен (по мнению сервера — всегда да, см. выше). */
  sent: boolean;
}

export default function PublicStatusPage(): ReactNode {
  const [orderNo, setOrderNo] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');

  const [requesting, setRequesting] = useState(false);
  const [requestState, setRequestState] = useState<RequestState | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [view, setView] = useState<PublicOrderStatusView | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  /** Запросить код на телефон клиента. */
  async function handleRequestCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    setRequesting(true);
    setRequestError(null);
    setCheckError(null);
    setView(null);

    try {
      await api.post('/public/order-status/request-code', { orderNo, phone });
      /*
       * Ответ всегда один и тот же, поэтому состояние тоже одно: «код отправлен,
       * если заказ существует». Текст не обещает, что заказ найден, — иначе мы
       * выдали бы то, что сервер намеренно скрывает.
       */
      setRequestState({ sent: true });
    } catch {
      /*
       * Ошибку показываем нейтрально: «не удалось отправить». Причина (лимит по
       * телефону или по адресу) клиенту не помогает, а лимит по адресу вводил бы
       * его в заблуждение — он относится ко всем посетителям, а не к нему.
       */
      setRequestError(
        'Не удалось отправить код. Проверьте номер заказа и телефон либо повторите позже.',
      );
    } finally {
      setRequesting(false);
    }
  }

  /** Проверить код и получить статус. */
  async function handleCheck(event: FormEvent): Promise<void> {
    event.preventDefault();
    setChecking(true);
    setCheckError(null);
    setView(null);

    try {
      const params = new URLSearchParams({ orderNo, code });
      const result = await api.get<{ ok: boolean; view: PublicOrderStatusView | null }>(
        `/public/order-status?${params.toString()}`,
      );

      if (result.ok && result.view !== null) {
        setView(result.view);
      } else {
        /*
         * Отказ не различает причину: «код не подошёл, истёк или использован» —
         * ровно то, что известно серверу. Разделять их значило бы подсказывать
         * перебирающему, что заказ существует.
         */
        setCheckError(
          'Код не подошёл, истёк или уже использован. Запросите новый код и попробуйте снова.',
        );
      }
    } catch {
      setCheckError('Не удалось проверить код. Повторите попытку позже.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Проверить статус заказа</h1>
        <p className="text-sm text-muted-foreground">
          Укажите номер заказа и телефон, который сообщили при приёме изделия. Мы отправим код
          подтверждения по SMS.
        </p>
      </header>

      <form
        onSubmit={(event) => {
          void handleRequestCode(event);
        }}
        className="space-y-4"
      >
        <Field label="Номер заказа" htmlFor="orderNo">
          <Input
            id="orderNo"
            value={orderNo}
            onChange={(e) => setOrderNo(e.target.value)}
            placeholder="МСК1-2609-000001"
            autoComplete="off"
            required
          />
        </Field>

        <Field label="Телефон" htmlFor="phone">
          <Input
            id="phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+7 900 123-45-67"
            inputMode="tel"
            autoComplete="tel"
            required
          />
        </Field>

        {requestError !== null && (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {requestError}
          </p>
        )}

        {requestState !== null && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            Если заказ с таким номером есть и телефон совпадает, код отправлен по SMS. Код действует
            10 минут.
          </p>
        )}

        <Button type="submit" disabled={requesting} className="w-full">
          {requesting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {requestState === null ? 'Получить код' : 'Отправить код ещё раз'}
        </Button>
      </form>

      <form
        onSubmit={(event) => {
          void handleCheck(event);
        }}
        className="space-y-4 border-t pt-6"
      >
        <Field label="Код из SMS" htmlFor="code">
          <Input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="1234"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
          />
        </Field>

        <Button type="submit" disabled={checking} variant="secondary" className="w-full">
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Проверить статус
        </Button>
      </form>

      {checkError !== null && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {checkError}
        </p>
      )}

      {view !== null && <StatusCard view={view} />}
    </main>
  );
}

/**
 * Карточка статуса.
 *
 * Показывается ровно то, что вернул сервер: состав полей задан на сервере и
 * проверяется тестом, поэтому страница не добавляет своих сведений о заказе —
 * иначе персональные данные просочились бы через интерфейс.
 */
function StatusCard({ view }: { view: PublicOrderStatusView }): ReactNode {
  const money = (minor: number): string =>
    (minor / 100).toLocaleString('ru-RU', { style: 'currency', currency: view.currency });

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <p className="text-sm text-muted-foreground">Заказ {view.orderNo}</p>
        <p className="text-lg font-semibold">{view.statusLabel}</p>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm">
        {view.dueAt !== null && (
          <>
            <dt className="text-muted-foreground">Ожидаемая готовность</dt>
            <dd>{new Date(view.dueAt).toLocaleDateString('ru-RU')}</dd>
          </>
        )}

        <dt className="text-muted-foreground">Стоимость</dt>
        <dd>{money(view.totalAmountMinor)}</dd>

        <dt className="text-muted-foreground">Оплачено</dt>
        <dd>{money(view.paidAmountMinor)}</dd>

        <dt className="text-muted-foreground">К доплате</dt>
        <dd>{money(view.remainingAmountMinor)}</dd>

        <dt className="text-muted-foreground">Телефон</dt>
        <dd>{view.phoneMask}</dd>
      </dl>
    </section>
  );
}
