/**
 * Настройки системы: реквизиты организации.
 *
 * ПОЧЕМУ ЭТО ВАЖНЕЕ, ЧЕМ ВЫГЛЯДИТ. Реквизиты печатаются в квитанции и акте —
 * документах, которые остаются у клиента. Ошибка здесь не проявляется ошибкой в
 * интерфейсе: в бумаге оказывается неверное наименование организации, и заметить
 * это можно только на печати. Поэтому проверяется не только сохранение, но и
 * поведение при испорченном значении и порядок источников.
 */

import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from './settings.service';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

function admin(): AuthenticatedUser {
  return {
    id: 'u-admin',
    email: 'admin@remixgold.ru',
    roles: ['ADMIN'],
    primaryRole: 'ADMIN',
    scope: 'ALL_STORES',
    scopes: ['ALL_STORES'],
    storeIds: [],
  } as unknown as AuthenticatedUser;
}

interface Options {
  stored?: unknown;
  envName?: string | undefined;
}

function makeService(options: Options = {}) {
  const upsert = vi.fn(async () => ({ key: 'organization.requisites' }));
  const auditCreate = vi.fn(async () => ({ id: 'a-1' }));

  const tx = {
    setting: { upsert },
    auditLog: { create: auditCreate },
  };

  const prisma = {
    setting: {
      findUnique: async () => (options.stored === undefined ? null : { value: options.stored }),
    },
    runInTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };

  const config = {
    get: (key: string) => (key === 'COMPANY_NAME' ? options.envName : undefined),
  };

  const service = new SettingsService(prisma as never, config as never);
  return { service, upsert, auditCreate };
}

describe('Настройки: чтение реквизитов', () => {
  it('сохранённые реквизиты возвращаются как есть', async () => {
    const { service } = makeService({
      stored: { name: 'ИП Бурда Виталий Валерьевич', inn: '246300000000' },
    });

    const requisites = await service.getOrganizationRequisites();

    expect(requisites.name).toBe('ИП Бурда Виталий Валерьевич');
    expect(requisites.inn).toBe('246300000000');
  });

  it('испорченное значение не роняет чтение', async () => {
    /*
     * Квитанцию нужно напечатать даже при испорченной настройке. Падение
     * остановило бы работу магазина, тогда как общее название просто заметно.
     */
    const { service } = makeService({ stored: 'мусор вместо объекта' });

    const requisites = await service.getOrganizationRequisites();

    expect(typeof requisites.name).toBe('string');
    expect(requisites.name.length).toBeGreaterThan(0);
  });

  it('отсутствие настройки — значение по умолчанию', async () => {
    const { service } = makeService();

    const requisites = await service.getOrganizationRequisites();

    expect(requisites.inn).toBeNull();
  });
});

describe('Настройки: сохранение реквизитов', () => {
  it('сохраняет заполненные реквизиты', async () => {
    const { service, upsert } = makeService();

    const saved = await service.saveOrganizationRequisites(
      {
        name: 'ИП Бурда Виталий Валерьевич',
        inn: '246300000000',
        phone: '+7 391 200-00-00',
        address: 'г. Красноярск, ул. Гусарова, 27',
      },
      admin(),
    );

    expect(saved.name).toBe('ИП Бурда Виталий Валерьевич');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('пустое название отклоняется', async () => {
    /*
     * Документ без исполнителя печатать нельзя: квитанция без наименования
     * организации не имеет силы. Проверка СХЕМОЙ, а не «на глаз» в интерфейсе.
     */
    const { service, upsert } = makeService();

    await expect(
      service.saveOrganizationRequisites({ name: '   ' }, admin()),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('пустые необязательные поля сохраняются как null', async () => {
    // Иначе в квитанции напечаталось бы «ИНН: » с пустым значением.
    const { service } = makeService();

    const saved = await service.saveOrganizationRequisites(
      { name: 'ИП Бурда', inn: '', phone: '  ', address: '' },
      admin(),
    );

    expect(saved.inn).toBeNull();
    expect(saved.phone).toBeNull();
    expect(saved.address).toBeNull();
  });

  it('null в необязательных полях принимается: это форма «не заполнено»', async () => {
    /*
     * Проверено на боевом сервере: клиент, прочитавший реквизиты и отправивший
     * их обратно без изменений, получал 400 на `inn: null`. Именно `null`
     * возвращает GET и хранит база, поэтому сохранение настроек ломалось бы
     * ровно тогда, когда ничего не меняли.
     */
    const { service } = makeService();

    const saved = await service.saveOrganizationRequisites(
      { name: 'ИП Бурда', inn: null, phone: null, address: null },
      admin(),
    );

    expect(saved).toMatchObject({ name: 'ИП Бурда', inn: null, phone: null, address: null });
  });

  it('прочитанные реквизиты можно сохранить обратно без изменений', async () => {
    // Круговой рейс GET → PUT: форма настроек загружает значение и отправляет
    // его назад. Если этот путь падает, администратор не может сохранить экран,
    // даже ничего не тронув.
    const { service } = makeService({
      stored: { name: 'ИП Бурда Виталий Валерьевич', inn: null, phone: null, address: null },
    });

    const loaded = await service.getOrganizationRequisites();
    const saved = await service.saveOrganizationRequisites(loaded, admin());

    expect(saved).toEqual(loaded);
  });

  it('запись и аудит — в одной транзакции', async () => {
    /*
     * Без записи в аудите нельзя ответить, кто и когда поменял наименование в
     * документах, — а им определяется, от чьего имени печатается квитанция.
     */
    const { service, upsert, auditCreate } = makeService();

    await service.saveOrganizationRequisites({ name: 'ИП Бурда' }, admin());

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const audit = auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({ action: 'SETTINGS_UPDATE' });
  });

  it('в аудите видны и прежнее, и новое наименование', async () => {
    // По журналу должно быть видно, какое наименование действовало когда.
    const { service, auditCreate } = makeService({
      stored: { name: 'ООО Старое' },
    });

    await service.saveOrganizationRequisites({ name: 'ИП Новое' }, admin());

    const audit = auditCreate.mock.calls[0]?.[0] as {
      data: { before: { name: string }; after: { name: string } };
    };
    expect(audit.data.before.name).toBe('ООО Старое');
    expect(audit.data.after.name).toBe('ИП Новое');
  });

  it('лишние поля не сохраняются', async () => {
    // Схема строгая: произвольный JSON не должен попасть в документы.
    const { service } = makeService();

    const saved = await service.saveOrganizationRequisites(
      { name: 'ИП Бурда', kpp: '246301001' },
      admin(),
    );

    expect(saved).not.toHaveProperty('kpp');
  });
});

describe('Настройки: наименование для печати', () => {
  it('название из настроек важнее окружения', async () => {
    /*
     * ГЛАВНАЯ проверка порядка источников. Иначе сохранённое администратором
     * название молча перебивалось бы переменной окружения, и правка «не
     * работала бы» — при том, что в интерфейсе всё сохранено.
     */
    const { service } = makeService({
      stored: { name: 'ИП Бурда Виталий Валерьевич' },
      envName: 'РЕМИКС ГОЛД',
    });

    expect(await service.organizationNameForPrint()).toBe('ИП Бурда Виталий Валерьевич');
  });

  it('пустые настройки — берётся окружение', async () => {
    // Переменная окружения остаётся запасным вариантом: до первого сохранения
    // поведение прежнее, и обновление ничего не ломает.
    const { service } = makeService({ envName: 'РЕМИКС ГОЛД' });

    expect(await service.organizationNameForPrint()).toBe('РЕМИКС ГОЛД');
  });

  it('пусто везде — печатается общее название, а не пустота', async () => {
    const { service } = makeService();

    const name = await service.organizationNameForPrint();

    expect(name.length).toBeGreaterThan(0);
  });
});
