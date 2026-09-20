import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORGANIZATION_NAME,
  ORGANIZATION_SETTING_KEY,
  defaultRequisites,
  isFilled,
  normalizeRequisites,
  organizationNameForPrint,
} from './organization.js';

/**
 * Реквизиты организации.
 *
 * Наименование печатается в квитанции и акте. Раньше оно задавалось переменной
 * окружения на сервере — чтобы поменять «РЕМИКС ГОЛД» на «ИП Бурда Виталий
 * Валерьевич», нужен доступ к серверу. Теперь значение хранится в настройках и
 * правится администратором.
 */
describe('Реквизиты организации: чтение из хранилища', () => {
  it('значение по умолчанию — только название', () => {
    // ИНН, телефон и адрес в образце квитанции не обязательны.
    expect(defaultRequisites()).toEqual({
      name: DEFAULT_ORGANIZATION_NAME,
      inn: null,
      phone: null,
      address: null,
    });
  });

  it('читает заполненные реквизиты', () => {
    const requisites = normalizeRequisites({
      name: 'ИП Бурда Виталий Валерьевич',
      inn: '246300000000',
      phone: '+7 391 200-00-00',
      address: 'г. Красноярск, ул. Гусарова, 27',
    });

    expect(requisites.name).toBe('ИП Бурда Виталий Валерьевич');
    expect(requisites.inn).toBe('246300000000');
    expect(requisites.address).toBe('г. Красноярск, ул. Гусарова, 27');
  });

  it('пустое значение в хранилище — это отсутствие значения', () => {
    /*
     * В JSON может оказаться пустая строка или строка из пробелов. Считать её
     * заполненной значило бы напечатать в документе пустую строку с двоеточием
     * («ИНН: »), а в интерфейсе — показать, что данные есть.
     */
    const requisites = normalizeRequisites({ name: '   ', inn: '', address: '  ' });

    expect(requisites.name).toBe(DEFAULT_ORGANIZATION_NAME);
    expect(requisites.inn).toBeNull();
    expect(requisites.address).toBeNull();
  });

  it('значения обрезаются от пробелов', () => {
    // «  ИП Бурда  » в документе выглядит как небрежность ввода.
    expect(normalizeRequisites({ name: '  ИП Бурда  ' }).name).toBe('ИП Бурда');
  });

  it('незнакомая форма значения не ломает чтение', () => {
    /*
     * Запись могла остаться от прежней версии, а поле могли дописать руками.
     * Падение на этом сделало бы невозможной печать ВСЕХ документов из-за одной
     * испорченной настройки.
     */
    for (const raw of [null, undefined, 'строка', 42, [], { name: 123 }]) {
      const requisites = normalizeRequisites(raw);
      expect(requisites.name, JSON.stringify(raw)).toBe(DEFAULT_ORGANIZATION_NAME);
    }
  });

  it('лишние ключи игнорируются, а не переносятся', () => {
    // Иначе произвольный JSON из настройки попал бы в документ.
    const requisites = normalizeRequisites({ name: 'ИП Бурда', kpp: '246301001' });

    expect(requisites).toEqual({
      name: 'ИП Бурда',
      inn: null,
      phone: null,
      address: null,
    });
    expect(requisites).not.toHaveProperty('kpp');
  });
});

describe('Реквизиты организации: что печатать', () => {
  it('название из настроек важнее окружения', () => {
    const name = organizationNameForPrint({
      requisites: { name: 'ИП Бурда Виталий Валерьевич', inn: null, phone: null, address: null },
      envFallback: 'РЕМИКС ГОЛД',
    });

    expect(name).toBe('ИП Бурда Виталий Валерьевич');
  });

  it('если в настройках пусто — берётся окружение', () => {
    /*
     * Переменная окружения остаётся ЗАПАСНЫМ вариантом: до первого сохранения
     * настроек поведение прежнее, и обновление ничего не ломает.
     */
    const name = organizationNameForPrint({
      requisites: defaultRequisites(),
      envFallback: 'РЕМИКС ГОЛД',
    });

    expect(name).toBe('РЕМИКС ГОЛД');
  });

  it('если пусто и там — общее название', () => {
    // Документ без исполнителя печатать нельзя, но и падать из-за этого он не
    // должен: печатается общее название, и это заметно.
    expect(organizationNameForPrint({ requisites: defaultRequisites(), envFallback: null })).toBe(
      DEFAULT_ORGANIZATION_NAME,
    );
    expect(organizationNameForPrint({ requisites: defaultRequisites(), envFallback: '   ' })).toBe(
      DEFAULT_ORGANIZATION_NAME,
    );
  });

  it('не подставляет окружение поверх названия из настроек', () => {
    /*
     * Регрессия на порядок источников. Настройки главнее: иначе сохранённое
     * администратором название молча перебивалось бы переменной окружения, и
     * правка «не работала бы».
     */
    const name = organizationNameForPrint({
      requisites: { name: 'ООО Другое', inn: null, phone: null, address: null },
      envFallback: 'РЕМИКС ГОЛД',
    });

    expect(name).toBe('ООО Другое');
    expect(name).not.toContain('РЕМИКС');
  });
});

describe('Реквизиты организации: заполненность', () => {
  it('пустые значения не считаются заполненными', () => {
    // По этому признаку квитанция решает, печатать ли строку вообще.
    expect(isFilled(null)).toBe(false);
    expect(isFilled(undefined)).toBe(false);
    expect(isFilled('')).toBe(false);
    expect(isFilled('   ')).toBe(false);
  });

  it('значение с текстом считается заполненным', () => {
    expect(isFilled('246300000000')).toBe(true);
    expect(isFilled(' ИП Бурда ')).toBe(true);
  });
});

describe('Реквизиты организации: ключ настройки', () => {
  it('ключ зафиксирован контрактом', () => {
    /*
     * Ключ — часть контракта между экраном настроек, квитанцией и актом. Его
     * изменение без миграции сделало бы сохранённые реквизиты невидимыми: в
     * документах печаталось бы значение по умолчанию, а администратор видел бы
     * пустую форму.
     */
    expect(ORGANIZATION_SETTING_KEY).toBe('organization.requisites');
  });
});
