'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useOrganizationRequisites, useSaveOrganizationRequisites } from '@/lib/queries';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Field, FormError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { describeApiError } from '@/lib/api-client';
import { t } from '@/lib/i18n';

/**
 * Настройки системы: реквизиты организации (требование заказчика).
 *
 * ## Зачем этот экран
 *
 * Наименование организации печатается в квитанции и акте. Раньше оно задавалось
 * переменной окружения на сервере: чтобы поменять «РЕМИКС ГОЛД» на «ИП Бурда
 * Виталий Валерьевич», нужен доступ к серверу и перезапуск сервиса. Директор
 * такого доступа не имеет, а реквизиты меняются без программиста.
 *
 * ## Почему право только у администратора
 *
 * Реквизиты определяют, от чьего имени печатается документ, который остаётся у
 * клиента. Это не рабочий параметр магазина, а юридический реквизит, поэтому
 * экран закрыт правом `settings:manage` — как и календарь с нормативами.
 */
export default function SettingsPage(): ReactNode {
  const { can } = useAuth();
  const toast = useToast();
  const allowed = can('settings:manage');

  const requisites = useOrganizationRequisites();
  const save = useSaveOrganizationRequisites();

  const [name, setName] = useState('');
  const [inn, setInn] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  /*
   * Форма заполняется ТОЛЬКО при первой загрузке, а не на каждое изменение
   * кэша. Иначе ответ сервера после сохранения затирал бы то, что сотрудник уже
   * начал править, и правки терялись бы молча.
   */
  const loaded = requisites.data;
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (loaded === undefined || initialized) return;
    setName(loaded.name);
    setInn(loaded.inn ?? '');
    setPhone(loaded.phone ?? '');
    setAddress(loaded.address ?? '');
    setInitialized(true);
  }, [loaded, initialized]);

  if (!allowed) {
    return (
      <EmptyState
        title="Раздел недоступен"
        hint="Настройки системы доступны только администратору."
      />
    );
  }

  if (requisites.isLoading) {
    return <p className="py-12 text-center text-sm text-slate-500">{t.common.loading}</p>;
  }

  if (requisites.isError) {
    return (
      <EmptyState
        title={t.errors.server}
        hint="Не удалось загрузить настройки. Обновите страницу."
      />
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    // Проверка та же, что на сервере: пустое название — документ без исполнителя.
    if (name.trim() === '') {
      setError('Укажите наименование организации');
      return;
    }

    try {
      await save.mutateAsync({ name: name.trim(), inn, phone, address });
      toast.showSuccess('Настройки сохранены');
    } catch (caught) {
      setError(describeApiError(caught));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t.settings.title}</h1>
        <p className="mt-1 text-sm text-slate-500">{t.settings.subtitle}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.organization}</CardTitle>
        </CardHeader>
        <CardBody>
          <form
            onSubmit={(event) => {
              void onSubmit(event);
            }}
            className="max-w-2xl space-y-4"
          >
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Эти данные печатаются в квитанции приёма и в акте приёма-передачи.
            </p>

            <Field label={t.settings.name} htmlFor="org-name" required>
              <Input
                id="org-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                placeholder="ИП Бурда Виталий Валерьевич"
              />
            </Field>

            <Field label={t.settings.inn} htmlFor="org-inn" hint="Необязательно">
              <Input
                id="org-inn"
                value={inn}
                onChange={(event) => setInn(event.target.value)}
                maxLength={20}
                inputMode="numeric"
              />
            </Field>

            <Field label={t.settings.phone} htmlFor="org-phone" hint="Необязательно">
              <Input
                id="org-phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                maxLength={30}
                placeholder="+7 391 200-00-00"
              />
            </Field>

            <Field label={t.settings.address} htmlFor="org-address" hint="Необязательно">
              <Input
                id="org-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                maxLength={300}
              />
            </Field>

            {error !== null ? <FormError>{error}</FormError> : null}

            <div className="flex justify-end">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? t.common.saving : t.common.save}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
