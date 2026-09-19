/**
 * Права маршрутов прейскуранта (задачи 1.4.2–1.4.3).
 *
 * Проверяются именно метаданные маршрутов, а не поведение сервиса: правило тут
 * целиком выражается декоратором, и его потеря не проявится ни в компиляции,
 * ни в тестах сервиса — только в том, что пользователь получит 403 или,
 * наоборот, лишний доступ.
 *
 * ЗАЧЕМ ЭТО НУЖНО. Матрица прав (docs/02-domain-and-roles.md §4) разводит правку
 * и утверждение прейскуранта по разным ролям. Ошибка в декораторе означает либо
 * утверждение «вслепую» (руководитель не видит цен, которые подписывает — этот
 * дефект и был найден), либо разрешение правки тому, кто утверждает.
 */

import { describe, expect, it } from 'vitest';
import { PERMISSIONS_KEY, STRICT_PERMISSION_KEY } from '../../common/auth/roles.decorator';
import { DictionariesAdminController } from './dictionaries-admin.controller';
import { PERMISSION } from '@app/shared';

/** Права, объявленные на методе контроллера. */
function permissionsOf(method: keyof DictionariesAdminController): unknown {
  return Reflect.getMetadata(PERMISSIONS_KEY, DictionariesAdminController.prototype[method]);
}

/** Помечен ли метод строгой проверкой (без пропуска администратора). */
function isStrict(method: keyof DictionariesAdminController): boolean {
  return (
    Reflect.getMetadata(STRICT_PERMISSION_KEY, DictionariesAdminController.prototype[method]) ===
    true
  );
}

describe('Прейскурант: права маршрутов', () => {
  it('ЧТЕНИЕ карточки версии доступно и утверждающему, а не только редактору', () => {
    /*
     * ГЛАВНАЯ ПРОВЕРКА. Руководитель и главный бухгалтер права правки не имеют.
     * Пока маршрут требовал только `pricelist:edit`, они получали 403 на
     * карточке версии — то есть не видели позиции, которые утверждают. Это
     * живой дефект, найденный прогоном: `GET /price-lists/:id/editor` → 403
     * для руководителя.
     */
    const permissions = permissionsOf('findPriceListForEdit');

    expect(permissions).toContain(PERMISSION.PRICELIST_EDIT);
    expect(permissions).toContain(PERMISSION.PRICELIST_APPROVE);
  });

  it('правка версии требует права правки и не даёт его утверждающему', () => {
    // Роли разведены: утверждающий не должен менять то, что подписывает.
    expect(permissionsOf('updatePriceList')).toEqual([PERMISSION.PRICELIST_EDIT]);
    expect(permissionsOf('createPriceList')).toEqual([PERMISSION.PRICELIST_EDIT]);
    expect(permissionsOf('createPriceListItem')).toEqual([PERMISSION.PRICELIST_EDIT]);
    expect(permissionsOf('updatePriceListItem')).toEqual([PERMISSION.PRICELIST_EDIT]);
    expect(permissionsOf('deactivatePriceListItem')).toEqual([PERMISSION.PRICELIST_EDIT]);
  });

  it('УТВЕРЖДЕНИЕ и отклонение требуют права утверждения', () => {
    expect(permissionsOf('approvePriceList')).toContain(PERMISSION.PRICELIST_APPROVE);
    expect(permissionsOf('rejectPriceList')).toContain(PERMISSION.PRICELIST_APPROVE);
    expect(permissionsOf('archivePriceList')).toContain(PERMISSION.PRICELIST_APPROVE);
  });

  it('УТВЕРЖДЕНИЕ помечено строгой проверкой — администратор не подписывает цены', () => {
    /*
     * Без строгой проверки `RolesGuard` пропустил бы администратора раньше
     * проверки прав, и разделение обязанностей исчезло бы: администратор правит
     * цены и он же их утверждает.
     */
    expect(isStrict('approvePriceList')).toBe(true);
    expect(isStrict('rejectPriceList')).toBe(true);
    expect(isStrict('archivePriceList')).toBe(true);
  });

  it('ПРАВКА версии НЕ помечена строгой проверкой', () => {
    /*
     * Администратор обязан сохранять доступ к настройке — строгая проверка
     * нужна только там, где право существует ради разделения обязанностей.
     * Пометив ею правку, мы отобрали бы у администратора его основную работу.
     */
    expect(isStrict('updatePriceList')).toBe(false);
    expect(isStrict('createPriceList')).toBe(false);
    expect(isStrict('updatePriceListItem')).toBe(false);
  });

  it('отправка на утверждение и возврат в черновик — это правка, а не утверждение', () => {
    // Отправляет тот, кто правил; подписывает — другой человек.
    expect(permissionsOf('submitPriceList')).toEqual([PERMISSION.PRICELIST_EDIT]);
    expect(permissionsOf('restorePriceListToDraft')).toEqual([PERMISSION.PRICELIST_EDIT]);
  });

  it('копирование версии требует права правки', () => {
    // Копия — начало новой правки, даже если исходная версия утверждена.
    expect(permissionsOf('copyPriceList')).toEqual([PERMISSION.PRICELIST_EDIT]);
  });
});
