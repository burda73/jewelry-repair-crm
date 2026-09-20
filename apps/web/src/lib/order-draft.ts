/**
 * Черновик мастера создания заказа: состав и признак «есть что сохранять»
 * (задача 1.7.3).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Признак «в форме что-то введено» решает, создавать ли
 * черновик. Ошибка здесь даёт мусор: пустая форма, открытая и закрытая
 * приёмщиком, оставляла бы черновик, и при следующем входе система предлагала бы
 * восстановить пустоту. Логика вынесена из компонента, чтобы её можно было
 * проверить тестом, а не только глазами.
 *
 * Справочные данные (цены работ) в черновик НЕ входят: они выводятся из металла
 * и действующего прейскуранта, а сохранённая копия цены «застряла» бы после
 * изменения прейскуранта — ровно тот дефект, ради которого цены сделаны
 * производными.
 */

/**
 * Минимум полей, нужных проверке «есть что сохранять».
 *
 * Тип СТРУКТУРНЫЙ, а не импортированный из мастера: мастер определяет свои
 * `DraftWork` и `CustomerSearchItem`, и импортировать их сюда означало бы
 * создать цикл (мастер → проверка → мастер). Проверке важны не типы позиций, а
 * только то, заполнены ли поля, которые вводит человек, и есть ли позиции.
 */
export interface OrderDraftContent {
  term: string;
  /** Выбранный клиент целиком; проверяется только на «выбран ли». */
  selectedCustomer: unknown;
  isNewCustomer: boolean;
  newCustomer: { fullName: string; phone: string; address: string; email: string; notes: string };
  item: {
    name: string;
    metal: string;
    weightGram: string;
    size: string;
    hallmark: string;
    defects: string;
    completeness: string;
  };
  works: readonly unknown[];
  description: string;
  prepayment: string;
  requiresPrepayment: boolean;
}
export function orderDraftHasContent(draft: OrderDraftContent): boolean {
  if (draft.term.trim() !== '') return true;
  // `!=` (нестрогое) намеренно: отсутствующее поле в старом черновике — это
  // `undefined`, и оно означает то же, что `null`, — клиент не выбран.
  if (draft.selectedCustomer != null) return true;
  if (draft.isNewCustomer) {
    /*
     * `address` участвует в проверке наравне с остальными полями: без него
     * черновик, в котором заполнили ТОЛЬКО адрес, считался бы пустым и был бы
     * потерян при закрытии страницы — а адрес нужен для печати квитанции.
     *
     * `?? ''` — для черновиков, сохранённых до появления поля: у них `address`
     * отсутствует, и обращение к нему уронило бы проверку.
     */
    const { fullName, phone, address, email, notes } = draft.newCustomer;
    if (
      fullName.trim() !== '' ||
      phone.trim() !== '' ||
      (address ?? '').trim() !== '' ||
      email.trim() !== '' ||
      notes.trim() !== ''
    ) {
      return true;
    }
  }

  const item = draft.item;
  if (
    item.name.trim() !== '' ||
    item.metal.trim() !== '' ||
    item.weightGram.trim() !== '' ||
    item.size.trim() !== '' ||
    item.hallmark.trim() !== '' ||
    item.defects.trim() !== '' ||
    item.completeness.trim() !== ''
  ) {
    return true;
  }

  if (draft.works.length > 0) return true;
  if (draft.description.trim() !== '') return true;
  if (draft.prepayment.trim() !== '') return true;
  if (draft.requiresPrepayment) return true;

  return false;
}
