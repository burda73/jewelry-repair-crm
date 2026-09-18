'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  History,
  Plus,
  Search,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/toast';
import {
  useCreateCustomer,
  useCreateOrder,
  useCustomerSearch,
  usePriceListItems,
  useStores,
  useWorkshops,
  type CreateOrderVariables,
} from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, FormError } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/card';
import { formatDateTime, formatMinor, formatMinorExact, plural } from '@/lib/format';
import { describeApiError } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { useDraftAutosave, type RestorableDraft } from '@/lib/draft-autosave';
import {
  parseMoneyInput,
  multiplyMinor,
  sumMinor,
  calcOrderTotal,
  resolveItemPrice,
  detectMetalKind,
  METAL_LABELS,
} from '@app/shared';
import type { CustomerSearchItem, PriceListItemOption } from '@/lib/api-types';

/**
 * Мастер создания заказа — 5 шагов (docs/08-ui-ux.md §4).
 *
 * Почему мастер, а не одна длинная форма: приём заказа — это последовательность
 * разных сущностей (клиент → согласие → изделие → работы → итог), и в одной
 * форме приёмщик терял бы, на чём остановился. Порядок шагов повторяет то, как
 * приёмщик реально разговаривает с клиентом.
 *
 * Заказ НЕ отправляется на промежуточных шагах: черновик живёт в состоянии
 * браузера и уходит одним запросом `POST /orders` на последнем шаге. Сервер
 * создаёт заказ целиком (с изделиями и работами) в одной транзакции, а
 * частично созданный заказ без изделий нарушил бы инварианты БД.
 */

const STEP_TITLES = ['Клиент', 'Согласие', 'Изделие', 'Работы', 'Итог'] as const;

type StepIndex = 0 | 1 | 2 | 3 | 4;

/**
 * Время сохранения черновика — только часы и минуты.
 *
 * Отдельная функция, а не `formatDateTime`: в подписи «черновик сохранён …»
 * дата избыточна (черновик живёт не дольше недели), а место занимает.
 */
function formatTime(value: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(value);
}

/** Работа в черновике: из прейскуранта или нетиповая. */
interface DraftWork {
  priceListItemId?: string;
  code: string;
  name: string;
  quantity: number;
  unit: string;
  unitPriceMinor: number;
  durationHours?: number;
  warrantyMonths: number;
  isCustom: boolean;
  /**
   * Признаки прейскуранта, показываемые приёмщику. Выставляются при выводе
   * цены (`pricedWorks`), а не хранятся: они следуют за выбранным металлом.
   */
  priceIsFrom?: boolean;
  metalCostSeparate?: boolean;
}

interface DraftItem {
  name: string;
  metal: string;
  weightGram: string;
  size: string;
  hallmark: string;
  defects: string;
  completeness: string;
}

/**
 * Черновик мастера (задача 1.7.3).
 *
 * Сохраняется всё, что приёмщик ввёл руками. Справочные данные (цены работ)
 * НЕ сохраняются: они выводятся из металла и прейскуранта, а сохранённая копия
 * цены могла бы «застрять» после изменения прейскуранта — ровно тот дефект,
 * ради которого цены сделаны производными.
 */
interface OrderDraft {
  step: number;
  term: string;
  /** Выбранный клиент целиком: восстановление не должно терять поля карточки. */
  selectedCustomer: CustomerSearchItem | null;
  isNewCustomer: boolean;
  newCustomer: { fullName: string; phone: string; email: string; notes: string };
  consentCallRecording: boolean;
  consentMarketing: boolean;
  item: DraftItem;
  works: DraftWork[];
  createdStoreId: string;
  pickupStoreId: string;
  workshopId: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  description: string;
  requiresPrepayment: boolean;
  prepayment: string;
}

const EMPTY_ITEM: DraftItem = {
  name: '',
  metal: '',
  weightGram: '',
  size: '',
  hallmark: '',
  defects: '',
  completeness: '',
};

export default function NewOrderPage(): ReactNode {
  const router = useRouter();
  const { can, user } = useAuth();
  const toast = useToast();

  const [step, setStep] = useState<StepIndex>(0);

  // Шаг 1 — клиент
  const [term, setTerm] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSearchItem | null>(null);
  const [isNewCustomer, setIsNewCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({
    fullName: '',
    phone: '',
    email: '',
    notes: '',
  });

  // Шаг 2 — согласие (ТЗ п. 2.4, обязательный пункт заявки)
  const [consentCallRecording, setConsentCallRecording] = useState(false);
  const [consentMarketing, setConsentMarketing] = useState(false);

  // Шаг 3 — изделие
  const [item, setItem] = useState<DraftItem>(EMPTY_ITEM);

  // Шаг 4 — работы
  const [works, setWorks] = useState<DraftWork[]>([]);
  const [showCustomWork, setShowCustomWork] = useState(false);
  const [customWork, setCustomWork] = useState({
    name: '',
    code: '',
    price: '',
    duration: '',
    warranty: '6',
  });

  // Шаг 5 — итог
  const [createdStoreId, setCreatedStoreId] = useState('');
  const [pickupStoreId, setPickupStoreId] = useState('');
  const [workshopId, setWorkshopId] = useState('');
  const [priority, setPriority] = useState<'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'>('NORMAL');
  const [description, setDescription] = useState('');
  const [requiresPrepayment, setRequiresPrepayment] = useState(false);
  const [prepayment, setPrepayment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: stores } = useStores();
  const { data: workshops } = useWorkshops();
  const { data: priceItems, isLoading: priceItemsLoading } = usePriceListItems();
  const search = useCustomerSearch(term);
  const createCustomer = useCreateCustomer();
  const createOrder = useCreateOrder();

  /*
   * Автосохранение черновика (задача 1.7.3).
   *
   * Приёмщика может отвлечь клиент: он уходит за изделием или отвечает на
   * звонок. Черновик хранится в localStorage под ключом сотрудника, поэтому
   * на общем компьютере точки данные одного приёмщика не открываются у другого.
   *
   * Черновик НЕ подставляется в форму автоматически — показывается отдельное
   * предложение с временем сохранения. Молчаливая подстановка означала бы, что
   * приёмщик, начавший новый заказ, видит в полях данные прошлого клиента.
   */
  const [draftRestored, setDraftRestored] = useState(false);
  const draftSnapshot: OrderDraft = useMemo(
    () => ({
      step,
      term,
      selectedCustomer,
      isNewCustomer,
      newCustomer,
      consentCallRecording,
      consentMarketing,
      item,
      works,
      createdStoreId,
      pickupStoreId,
      workshopId,
      priority,
      description,
      requiresPrepayment,
      prepayment,
    }),
    [
      step,
      term,
      selectedCustomer,
      isNewCustomer,
      newCustomer,
      consentCallRecording,
      consentMarketing,
      item,
      works,
      createdStoreId,
      pickupStoreId,
      workshopId,
      priority,
      description,
      requiresPrepayment,
      prepayment,
    ],
  );
  const draft = useDraftAutosave<OrderDraft>({
    scope: 'order-new',
    userId: user?.id ?? null,
    snapshot: draftSnapshot,
    // После создания заказа сохранять нечего: черновик уже стал заказом.
    enabled: !draftRestored && createOrder.isSuccess === false,
  });

  /**
   * Привести сохранённый номер шага к допустимому.
   *
   * Черновик мог быть записан до изменения числа шагов мастера; значение вне
   * диапазона оставило бы форму без содержимого — ни один блок не отрисовался
   * бы, и приёмщик увидел бы пустой экран.
   */
  function clampStep(value: number): StepIndex {
    if (!Number.isInteger(value) || value < 0) return 0;
    if (value > STEP_TITLES.length - 1) return (STEP_TITLES.length - 1) as StepIndex;
    return value as StepIndex;
  }

  /** Применить найденный черновик к форме. */
  function applyDraft(found: RestorableDraft<OrderDraft>): void {
    const data = found.data;
    setStep(clampStep(data.step));
    setTerm(data.term);
    setIsNewCustomer(data.isNewCustomer);
    setNewCustomer(data.newCustomer);
    setConsentCallRecording(data.consentCallRecording);
    setConsentMarketing(data.consentMarketing);
    setItem(data.item);
    setWorks(data.works);
    setCreatedStoreId(data.createdStoreId);
    setPickupStoreId(data.pickupStoreId);
    setWorkshopId(data.workshopId);
    setPriority(data.priority);
    setDescription(data.description);
    setRequiresPrepayment(data.requiresPrepayment);
    setPrepayment(data.prepayment);
    /*
     * Клиент восстанавливается по сохранённым id и подписи, а не поиском:
     * повторный запрос к API мог бы вернуть изменённую карточку, и приёмщик
     * увидел бы не то, что выбирал. Если карточку удалили, приёмщик просто
     * выберет клиента заново — это видно и понятно.
     */
    setSelectedCustomer(data.selectedCustomer);
    draft.dismiss();
    setDraftRestored(true);
    toast.showSuccess('Черновик восстановлен');
  }

  // Приёмщик ограничен своими магазинами; руководитель видит все.
  const availableStores = useMemo(() => {
    const list = stores ?? [];
    if (user === null || user.scope === 'ALL_STORES') return list.filter((s) => s.isActive);
    const allowed = new Set(user.storeIds);
    return list.filter((store) => allowed.has(store.id));
  }, [stores, user]);

  // Магазин по умолчанию подставляется, как только справочник загрузился.
  const defaultStoreId = availableStores[0]?.id ?? '';
  const effectiveCreatedStore = createdStoreId === '' ? defaultStoreId : createdStoreId;
  const effectivePickupStore = pickupStoreId === '' ? effectiveCreatedStore : pickupStoreId;

  // Итог считаем теми же доменными функциями, что и сервер: расхождение между
  // показанной и фактической суммой заказа недопустимо.

  /*
   * Металл изделия определяет цену работы.
   *
   * Приёмщик вводит металл свободным текстом («Золото 585», «Ag925»), а
   * прейскурант оперирует кодами GOLD/SILVER. Распознаём тот же функцией,
   * что и остальной код; если не распознали — цену не угадываем, а берём
   * ставку по умолчанию и предупреждаем приёмщика ниже.
   */
  const detectedMetal = useMemo(() => detectMetalKind(item.metal), [item.metal]);

  /*
   * Цены работ не хранятся в состоянии, а ВЫВОДЯТСЯ из металла и позиции
   * прейскуранта. Так цена не может «застрять» на прежнем металле: если
   * приёмщик вернулся на шаг назад и исправил металл с золота на серебро,
   * сумма пересчитается сама. Хранение цены в состоянии потребовало бы
   * синхронизации при каждом изменении металла, и её легко забыть.
   *
   * Нетиповые работы цену хранят: их назначает сотрудник, прейскуранта нет.
   */
  const pricedWorks = useMemo(() => {
    return works.map((work) => {
      if (work.isCustom || work.priceListItemId === undefined) return work;

      const entry = (priceItems ?? []).find((candidate) => candidate.id === work.priceListItemId);
      if (entry === undefined) return work;

      const resolved = resolveItemPrice(entry, detectedMetal);
      return {
        ...work,
        unitPriceMinor: resolved.priceMinor,
        priceIsFrom: resolved.isFrom,
        metalCostSeparate: resolved.metalCostSeparate,
      };
    });
  }, [works, priceItems, detectedMetal]);

  // Работа из прейскуранта посчитана по цене по умолчанию, потому что металл
  // не распознан или ставки по нему нет. Показываем предупреждение: молча
  // применить не ту ставку — это ошибка в деньгах клиента.
  const metalFallbackUsed = useMemo(
    () =>
      detectedMetal === null &&
      pricedWorks.some((work) => !work.isCustom && work.priceListItemId !== undefined),
    [detectedMetal, pricedWorks],
  );

  // Признак «стоимость металла считается отдельно» — предупреждение приёмщику.
  const metalCostSeparateUsed = useMemo(
    () => pricedWorks.some((work) => work.metalCostSeparate === true),
    [pricedWorks],
  );

  const worksTotalMinor = useMemo(
    () => sumMinor(...pricedWorks.map((work) => multiplyMinor(work.unitPriceMinor, work.quantity))),
    [pricedWorks],
  );
  const totalMinor = useMemo(
    () => calcOrderTotal({ worksTotalMinor, stonesTotalMinor: 0, discountMinor: 0 }),
    [worksTotalMinor],
  );

  const prepaymentMinor = useMemo(() => {
    if (!requiresPrepayment || prepayment.trim() === '') return 0;
    return parseMoneyInput(prepayment) ?? 0;
  }, [requiresPrepayment, prepayment]);

  const prepaymentInvalid = requiresPrepayment && prepaymentMinor > totalMinor;
  // «Требуется предоплата» без суммы — противоречие: в заказе осталось бы
  // `requiresPrepayment = true` при `prepaymentRequiredMinor = 0`. Проверка
  // старта работ такое состояние пропускает (ноль считается выполненным), но
  // в отчётности и в карточке это выглядело бы как незаполненное условие,
  // поэтому сумма обязательна, если флаг включён.
  const prepaymentMissing = requiresPrepayment && prepaymentMinor <= 0;

  if (!can('order:create')) {
    return <EmptyState title={t.errors.forbidden} hint="Создание заказов недоступно вашей роли" />;
  }

  /** Проверка текущего шага перед переходом дальше. */
  function validateStep(current: StepIndex): string | null {
    if (current === 0) {
      if (selectedCustomer === null && !isNewCustomer) {
        return 'Выберите существующего клиента или создайте нового';
      }
      if (isNewCustomer && selectedCustomer === null) {
        if (newCustomer.fullName.trim().length < 2) return 'Укажите ФИО клиента';
        if (newCustomer.phone.trim().length < 5) return 'Укажите телефон клиента';
      }
      return null;
    }

    if (current === 1) {
      // ТЗ п. 2.4: без согласия на запись разговора заказ не оформляется.
      if (!consentCallRecording) {
        return 'Без согласия клиента на запись разговора заказ оформить нельзя (ТЗ п. 2.4)';
      }
      return null;
    }

    if (current === 2) {
      if (item.name.trim().length < 2) return 'Укажите наименование изделия';
      return null;
    }

    if (current === 3) {
      if (works.length === 0) return 'Добавьте хотя бы одну работу';
      return null;
    }

    return null;
  }

  function goNext(): void {
    const problem = validateStep(step);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setStep((step + 1) as StepIndex);
  }

  function goBack(): void {
    setError(null);
    setStep((step - 1) as StepIndex);
  }

  function addPriceWork(entry: PriceListItemOption): void {
    setWorks((previous) => {
      // Повторное нажатие на ту же позицию увеличивает количество, а не
      // добавляет вторую строку: приёмщику так проще считать «две операции».
      const existing = previous.find((work) => work.priceListItemId === entry.id);
      if (existing !== undefined) {
        return previous.map((work) =>
          work.priceListItemId === entry.id ? { ...work, quantity: work.quantity + 1 } : work,
        );
      }
      return [
        ...previous,
        {
          priceListItemId: entry.id,
          code: entry.code,
          name: entry.name,
          quantity: 1,
          unit: entry.unit,
          // Цена здесь — только начальное значение; фактическая выводится из
          // металла изделия в `pricedWorks` и пересчитывается при его смене.
          unitPriceMinor: resolveItemPrice(entry, detectedMetal).priceMinor,
          ...(entry.durationHours === null ? {} : { durationHours: entry.durationHours }),
          warrantyMonths: entry.warrantyMonths ?? 6,
          isCustom: false,
        },
      ];
    });
  }

  function addCustomWork(): void {
    const price = parseMoneyInput(customWork.price);
    if (customWork.name.trim().length < 2 || price === null || price <= 0) {
      setError('Для нетиповой работы укажите название и цену');
      return;
    }
    const duration = Number(customWork.duration);
    const warranty = Number(customWork.warranty);

    setWorks((previous) => [
      ...previous,
      {
        // Код обязателен в схеме, но у нетиповой работы своего кода нет.
        code: customWork.code.trim() === '' ? 'CUSTOM' : customWork.code.trim(),
        name: customWork.name.trim(),
        quantity: 1,
        unit: 'шт',
        unitPriceMinor: price,
        ...(Number.isFinite(duration) && duration > 0 ? { durationHours: duration } : {}),
        warrantyMonths: Number.isFinite(warranty) && warranty >= 0 ? warranty : 0,
        isCustom: true,
      },
    ]);
    setCustomWork({ name: '', code: '', price: '', duration: '', warranty: '6' });
    setShowCustomWork(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (effectiveCreatedStore === '') {
      setError('Не удалось определить магазин приёма. Обновите страницу.');
      return;
    }
    if (prepaymentInvalid) {
      setError('Предоплата не может превышать сумму заказа');
      return;
    }
    if (prepaymentMissing) {
      setError('Укажите сумму предоплаты или снимите отметку «Требуется предоплата»');
      return;
    }

    // Клиента создаём ДО заказа: если создание заказа не удастся, клиент
    // останется в базе — это безопасно (он реальный) и позволяет повторить
    // оформление без повторного ввода. Обратный порядок оставил бы заказ без
    // клиента, а это нарушило бы обязательную связь.
    let customerId = selectedCustomer?.id;

    if (isNewCustomer && customerId === undefined) {
      try {
        const created = await createCustomer.mutateAsync({
          fullName: newCustomer.fullName.trim(),
          phone: newCustomer.phone.trim(),
          ...(newCustomer.email.trim() === '' ? {} : { email: newCustomer.email.trim() }),
          consentCallRecording,
          consentMarketing,
          ...(newCustomer.notes.trim() === '' ? {} : { notes: newCustomer.notes.trim() }),
        });
        customerId = created.id;
      } catch (caught: unknown) {
        // Конфликт по телефону — частый случай: клиент уже есть, но приёмщик
        // его не нашёл. Подсказываем конкретное действие, а не «ошибка».
        setError(`${describeApiError(caught)} Вернитесь на шаг 1 и найдите клиента по телефону.`);
        return;
      }
    }

    const payload: CreateOrderVariables = {
      createdStoreId: effectiveCreatedStore,
      pickupStoreId: effectivePickupStore,
      ...(workshopId === '' ? {} : { workshopId }),
      priority,
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      requiresPrepayment,
      prepaymentRequiredMinor: requiresPrepayment ? prepaymentMinor : 0,
      items: [
        {
          name: item.name.trim(),
          ...(item.metal.trim() === '' ? {} : { metal: item.metal.trim() }),
          ...(item.weightGram.trim() === ''
            ? {}
            : { weightGram: Number(item.weightGram.replace(',', '.')) }),
          ...(item.size.trim() === '' ? {} : { size: item.size.trim() }),
          ...(item.hallmark.trim() === '' ? {} : { hallmark: item.hallmark.trim() }),
          ...(item.defects.trim() === '' ? {} : { defects: item.defects.trim() }),
          ...(item.completeness.trim() === '' ? {} : { completeness: item.completeness.trim() }),
        },
      ],
      /*
       * Отправляем `pricedWorks`, а не `works`: сервер сверяет цену с
       * действующим прейскурантом по металлу изделия и отклонит заказ при
       * расхождении (409 PRICE_MISMATCH). Цена в состоянии может быть
       * устаревшей, если приёмщик изменил металл после добавления работы.
       *
       * Заодно проставляем `itemIndex`: изделие в мастере одно, поэтому 0.
       * Привязка нужна, чтобы сервер взял ставку по металлу именно этого
       * изделия.
       */
      works: pricedWorks.map((work) => ({
        code: work.code,
        name: work.name,
        quantity: work.quantity,
        unit: work.unit,
        unitPriceMinor: work.unitPriceMinor,
        warrantyMonths: work.warrantyMonths,
        isCustom: work.isCustom,
        itemIndex: 0,
        ...(work.priceListItemId === undefined ? {} : { priceListItemId: work.priceListItemId }),
        ...(work.durationHours === undefined ? {} : { durationHours: work.durationHours }),
      })),
      ...(customerId === undefined ? {} : { customerId }),
    };

    try {
      const created = await createOrder.mutateAsync(payload);
      // Черновик стал заказом: хранить его копию незачем, а на общем
      // компьютере она содержала бы персональные данные уже принятого клиента.
      draft.forget();
      toast.showSuccess(`Заказ ${created.orderNo} создан`);
      router.push(`/orders/${created.id}`);
    } catch (caught: unknown) {
      setError(describeApiError(caught));
    }
  }

  const totalPositions = works.reduce((acc, work) => acc + work.quantity, 0);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link
        href="/orders"
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t.orders.title}
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-slate-900">Новый заказ</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Шаг {step + 1} из {STEP_TITLES.length} · {STEP_TITLES[step]}
          {/*
            Подпись о сохранении. Без неё приёмщик не знает, сохранился ли
            ввод, и либо боится уйти от компьютера, либо теряет данные.
          */}
          {draft.savedAt !== null && (
            <span className="text-slate-400"> · черновик сохранён {formatTime(draft.savedAt)}</span>
          )}
        </p>
      </div>

      {/* Индикатор шагов: видно и текущий шаг, и пройденные. Возврат назад
          свободен, вперёд — только если текущий шаг заполнен верно. */}
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {STEP_TITLES.map((title, index) => {
          const isDone = index < step;
          const isCurrent = index === step;
          return (
            <li key={title} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (index < step) {
                    setStep(index as StepIndex);
                    setError(null);
                  }
                }}
                disabled={index > step}
                aria-current={isCurrent ? 'step' : undefined}
                className={[
                  'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition',
                  isCurrent
                    ? 'bg-slate-900 text-white'
                    : isDone
                      ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'bg-slate-100 text-slate-400',
                ].join(' ')}
              >
                {isDone ? (
                  <Check className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <span>{index + 1}</span>
                )}
                {title}
              </button>
              {index < STEP_TITLES.length - 1 ? (
                <span className="text-slate-300" aria-hidden="true">
                  →
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      {/*
        Предложение восстановить черновик. Показывается ТОЛЬКО пока приёмщик не
        решил: молчаливая подстановка означала бы, что в полях нового заказа
        оказались данные прошлого клиента.
      */}
      {draft.restorable !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <History className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Найден незавершённый черновик от{' '}
              <strong>{formatDateTime(draft.restorable.savedAt)}</strong>. Восстановить введённые
              данные?
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => draft.dismiss()}>
              Начать заново
            </Button>
            <Button size="sm" onClick={() => applyDraft(draft.restorable!)}>
              Восстановить
            </Button>
          </div>
        </div>
      )}

      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        className="rounded-lg border border-slate-200 bg-white p-5"
      >
        {/* Шаг 1. Клиент */}
        {step === 0 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Клиент</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Найдите клиента по телефону или ФИО, чтобы не создавать дубль
              </p>
            </div>

            {selectedCustomer === null ? (
              <>
                <Field label="Поиск" htmlFor="customer-search" hint="Минимум 3 символа">
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                      aria-hidden="true"
                    />
                    <Input
                      id="customer-search"
                      value={term}
                      onChange={(event) => {
                        setTerm(event.target.value);
                        setIsNewCustomer(false);
                        setError(null);
                      }}
                      placeholder="+7 916 123-45-67 или Иванов"
                      className="pl-9"
                      autoComplete="off"
                    />
                  </div>
                </Field>

                {term.trim().length >= 3 ? (
                  search.isFetching && search.data === undefined ? (
                    <p className="text-sm text-slate-500">Поиск…</p>
                  ) : (search.data ?? []).length === 0 ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                      <p className="text-sm text-amber-800">
                        Клиент не найден. Проверьте другой формат номера или создайте нового.
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        className="mt-2"
                        onClick={() => {
                          setIsNewCustomer(true);
                          // Подставляем введённое: если это телефон — он попадёт
                          // в поле телефона, а если ФИО — в поле имени.
                          const looksLikePhone = /^[\d+()\s-]+$/.test(term.trim());
                          setNewCustomer({
                            fullName: looksLikePhone ? '' : term.trim(),
                            phone: looksLikePhone ? term.trim() : '',
                            email: '',
                            notes: '',
                          });
                        }}
                      >
                        <UserPlus className="h-4 w-4" aria-hidden="true" />
                        Создать нового клиента
                      </Button>
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                      {(search.data ?? []).map((customer) => (
                        <li key={customer.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCustomer(customer);
                              // Согласие уже дано ранее — переносим его в заказ,
                              // чтобы приёмщик не спрашивал клиента второй раз.
                              setConsentCallRecording(customer.consentCallRecording);
                              setConsentMarketing(customer.consentMarketing);
                              setIsNewCustomer(false);
                              setError(null);
                            }}
                            className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-slate-50"
                          >
                            <div>
                              <p className="text-sm font-medium text-slate-900">
                                {customer.fullName}
                              </p>
                              <p className="text-xs text-slate-500">{customer.phone}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-slate-500">
                                {customer.ordersCount}{' '}
                                {plural(customer.ordersCount, 'заказ', 'заказа', 'заказов')}
                              </p>
                              {customer.lastOrder !== null ? (
                                <p className="text-xs text-slate-400">
                                  последний: {customer.lastOrder.orderNo}
                                </p>
                              ) : null}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}

                {!isNewCustomer ? (
                  <Button type="button" variant="ghost" onClick={() => setIsNewCustomer(true)}>
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                    Новый клиент
                  </Button>
                ) : null}
              </>
            ) : (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-emerald-900">
                      {selectedCustomer.fullName}
                    </p>
                    <p className="text-xs text-emerald-700">{selectedCustomer.phone}</p>
                    {selectedCustomer.ordersCount > 0 ? (
                      <p className="mt-1 text-xs text-emerald-700">
                        Уже оформлялся: {selectedCustomer.ordersCount}{' '}
                        {plural(selectedCustomer.ordersCount, 'заказ', 'заказа', 'заказов')}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setSelectedCustomer(null);
                      setConsentCallRecording(false);
                      setConsentMarketing(false);
                    }}
                  >
                    Изменить
                  </Button>
                </div>
              </div>
            )}

            {isNewCustomer && selectedCustomer === null ? (
              <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-medium text-slate-900">Новый клиент</p>
                <Field label="ФИО" htmlFor="new-fullname" required>
                  <Input
                    id="new-fullname"
                    value={newCustomer.fullName}
                    onChange={(event) =>
                      setNewCustomer({ ...newCustomer, fullName: event.target.value })
                    }
                    maxLength={200}
                  />
                </Field>
                <Field label="Телефон" htmlFor="new-phone" required>
                  <Input
                    id="new-phone"
                    value={newCustomer.phone}
                    onChange={(event) =>
                      setNewCustomer({ ...newCustomer, phone: event.target.value })
                    }
                    placeholder="+7 916 123-45-67"
                    maxLength={30}
                  />
                </Field>
                <Field label="Email" htmlFor="new-email" hint="Необязательно">
                  <Input
                    id="new-email"
                    type="email"
                    value={newCustomer.email}
                    onChange={(event) =>
                      setNewCustomer({ ...newCustomer, email: event.target.value })
                    }
                    maxLength={200}
                  />
                </Field>
                <Field label="Примечания" htmlFor="new-notes" hint="Необязательно">
                  <Textarea
                    id="new-notes"
                    value={newCustomer.notes}
                    onChange={(event) =>
                      setNewCustomer({ ...newCustomer, notes: event.target.value })
                    }
                    maxLength={2000}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Шаг 2. Согласие (ТЗ п. 2.4) */}
        {step === 1 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Согласие клиента</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Обязательный пункт заявки по ТЗ п. 2.4
              </p>
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-4 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={consentCallRecording}
                onChange={(event) => setConsentCallRecording(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>
                <span className="block text-sm font-medium text-slate-900">
                  Согласие на запись разговора
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Клиент согласен на аудиозапись общения по заказу. Без этой отметки оформление
                  заказа невозможно.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-4 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={consentMarketing}
                onChange={(event) => setConsentMarketing(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>
                <span className="block text-sm font-medium text-slate-900">
                  Согласие на рекламные сообщения
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Необязательно. Можно изменить позже в карточке клиента.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {/* Шаг 3. Изделие */}
        {step === 2 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Изделие</h2>
              <p className="mt-0.5 text-sm text-slate-500">Принимается одно изделие на заказ</p>
            </div>

            <Field label="Наименование" htmlFor="item-name" required>
              <Input
                id="item-name"
                value={item.name}
                onChange={(event) => {
                  setItem({ ...item, name: event.target.value });
                  setError(null);
                }}
                placeholder="Кольцо обручальное"
                maxLength={200}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Металл" htmlFor="item-metal">
                <Input
                  id="item-metal"
                  value={item.metal}
                  onChange={(event) => setItem({ ...item, metal: event.target.value })}
                  placeholder="Золото 585"
                  maxLength={50}
                />
                {/*
                  Металл определяет цену работ: прейскурант задаёт отдельные
                  цены по золоту и серебру. Показываем распознанный металл,
                  чтобы приёмщик видел, по какой колонке считается заказ.
                */}
                {detectedMetal !== null ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Цены по прейскуранту:{' '}
                    <span className="font-medium">{METAL_LABELS[detectedMetal]}</span>
                  </p>
                ) : item.metal.trim() !== '' ? (
                  <p className="mt-1 text-xs text-amber-600">
                    Металл не распознан — работы считаются по цене золота. Укажите «Золото» или
                    «Серебро».
                  </p>
                ) : null}
              </Field>
              <Field label="Вес, г" htmlFor="item-weight">
                <Input
                  id="item-weight"
                  value={item.weightGram}
                  onChange={(event) => setItem({ ...item, weightGram: event.target.value })}
                  inputMode="decimal"
                  placeholder="4,25"
                />
              </Field>
              <Field label="Размер" htmlFor="item-size">
                <Input
                  id="item-size"
                  value={item.size}
                  onChange={(event) => setItem({ ...item, size: event.target.value })}
                  placeholder="17,5"
                  maxLength={30}
                />
              </Field>
            </div>

            <Field label="Проба / клеймо" htmlFor="item-hallmark">
              <Input
                id="item-hallmark"
                value={item.hallmark}
                onChange={(event) => setItem({ ...item, hallmark: event.target.value })}
                maxLength={50}
              />
            </Field>

            <Field label="Дефекты" htmlFor="item-defects" hint="Что нужно исправить">
              <Textarea
                id="item-defects"
                value={item.defects}
                onChange={(event) => setItem({ ...item, defects: event.target.value })}
                maxLength={2000}
              />
            </Field>

            <Field label="Комплектность" htmlFor="item-completeness">
              <Input
                id="item-completeness"
                value={item.completeness}
                onChange={(event) => setItem({ ...item, completeness: event.target.value })}
                maxLength={500}
              />
            </Field>
          </div>
        ) : null}

        {/* Шаг 4. Работы */}
        {step === 3 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Работы</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Выберите из прейскуранта или добавьте нетиповую работу
              </p>
              {/* Металл изделия определяет цену: прейскурант задаёт отдельные
                  цены по золоту и серебру. Показываем, по какой колонке считаем. */}
              {detectedMetal !== null ? (
                <p className="mt-1 text-xs text-slate-500">
                  Цены прейскуранта:{' '}
                  <span className="font-medium">{METAL_LABELS[detectedMetal]}</span>
                </p>
              ) : null}
            </div>

            {/* Металл не распознан, поэтому работы посчитаны по цене золота.
                Молчать об этом нельзя: серебряное изделие окажется примерно
                вдвое дороже, и приёмщик узнает об этом только от клиента. */}
            {metalFallbackUsed ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Металл изделия не распознан, поэтому работы посчитаны по цене золота. Вернитесь на
                шаг «Изделие» и укажите «Золото» или «Серебро».
              </p>
            ) : null}

            {/* Стоимость металла в цену не входит — 3 позиции прейскуранта. */}
            {metalCostSeparateUsed ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                В выбранных работах стоимость металла считается отдельно и в итог не входит.
                Согласуйте её с клиентом дополнительно.
              </p>
            ) : null}

            {works.length > 0 ? (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {/* Показываем `pricedWorks`: цена уже пересчитана по металлу
                    изделия. Из `works` она могла быть устаревшей. */}
                {pricedWorks.map((work, index) => (
                  <li
                    key={`${work.code}-${String(index)}`}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">{work.name}</p>
                      <p className="text-xs text-slate-500">
                        {work.priceIsFrom === true ? 'от ' : ''}
                        {formatMinorExact(work.unitPriceMinor)} × {work.quantity} {work.unit}
                        {work.isCustom ? ' · нетиповая' : ''}
                      </p>
                      {work.metalCostSeparate === true ? (
                        <p className="text-xs text-amber-600">
                          Стоимость металла считается отдельно
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={1}
                        value={work.quantity}
                        onChange={(event) => {
                          const quantity = Math.max(1, Number(event.target.value) || 1);
                          setWorks((previous) =>
                            previous.map((entry, i) =>
                              i === index ? { ...entry, quantity } : entry,
                            ),
                          );
                        }}
                        className="w-16 text-center"
                        aria-label={`Количество: ${work.name}`}
                      />
                      <span className="w-24 text-right text-sm font-medium text-slate-900">
                        {formatMinor(multiplyMinor(work.unitPriceMinor, work.quantity))}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setWorks((previous) => previous.filter((_, i) => i !== index))
                        }
                        aria-label={`Удалить работу ${work.name}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
                Работы пока не добавлены
              </p>
            )}

            <div className="rounded-md border border-slate-200">
              <p className="border-b border-slate-100 px-3 py-2 text-sm font-medium text-slate-900">
                Прейскурант
              </p>
              {priceItemsLoading ? (
                <p className="p-3 text-sm text-slate-500">Загрузка…</p>
              ) : (priceItems ?? []).length === 0 ? (
                <p className="p-3 text-sm text-slate-500">
                  Утверждённый прейскурант не найден. Добавьте нетиповую работу.
                </p>
              ) : (
                <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto">
                  {(priceItems ?? []).map((entry) => {
                    /*
                     * Показываем цену ТОГО металла, что указан в изделии:
                     * прейскурант задаёт отдельные цены по золоту и серебру,
                     * и приёмщик должен видеть сумму, которая попадёт в заказ.
                     * Если металл не распознан — цену по умолчанию.
                     */
                    const resolved = resolveItemPrice(entry, detectedMetal);
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          onClick={() => addPriceWork(entry)}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm text-slate-900">{entry.name}</p>
                            <p className="text-xs text-slate-500">
                              {entry.code}
                              {entry.category !== null ? ` · ${entry.category.name}` : ''}
                              {entry.unit !== 'шт' ? ` · за ${entry.unit}` : ''}
                              {entry.durationHours !== null ? ` · ${entry.durationHours} ч` : ''}
                            </p>
                            {entry.metalCostSeparate ? (
                              <p className="text-xs text-amber-600">
                                Стоимость металла считается отдельно
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-right text-sm font-medium text-slate-900">
                              {/* «от» — цена минимальная, итог уточняется. */}
                              {resolved.isFrom ? 'от ' : ''}
                              {formatMinor(resolved.priceMinor)}
                              {entry.unit !== 'шт' ? `/${entry.unit}` : ''}
                            </span>
                            <Plus className="h-4 w-4 text-slate-400" aria-hidden="true" />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {showCustomWork ? (
              <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-medium text-slate-900">Нетиповая работа</p>
                <Field label="Название" htmlFor="custom-name" required>
                  <Input
                    id="custom-name"
                    value={customWork.name}
                    onChange={(event) => setCustomWork({ ...customWork, name: event.target.value })}
                    maxLength={200}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Цена, ₽" htmlFor="custom-price" required>
                    <Input
                      id="custom-price"
                      value={customWork.price}
                      onChange={(event) =>
                        setCustomWork({ ...customWork, price: event.target.value })
                      }
                      inputMode="decimal"
                    />
                  </Field>
                  <Field label="Часы" htmlFor="custom-duration">
                    <Input
                      id="custom-duration"
                      value={customWork.duration}
                      onChange={(event) =>
                        setCustomWork({ ...customWork, duration: event.target.value })
                      }
                      inputMode="numeric"
                    />
                  </Field>
                  <Field label="Гарантия, мес." htmlFor="custom-warranty">
                    <Input
                      id="custom-warranty"
                      value={customWork.warranty}
                      onChange={(event) =>
                        setCustomWork({ ...customWork, warranty: event.target.value })
                      }
                      inputMode="numeric"
                    />
                  </Field>
                </div>
                <div className="flex gap-2">
                  <Button type="button" onClick={addCustomWork}>
                    Добавить
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setShowCustomWork(false)}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="secondary" onClick={() => setShowCustomWork(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Нетиповая работа
              </Button>
            )}

            {works.length > 0 ? (
              <div className="flex items-center justify-between border-t border-slate-200 pt-3">
                <span className="text-sm text-slate-500">Сумма работ</span>
                <span className="text-lg font-semibold text-slate-900">
                  {formatMinorExact(totalMinor)}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Шаг 5. Итог */}
        {step === 4 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Итог и срок</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Проверьте данные перед созданием заказа
              </p>
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Клиент</dt>
                  <dd className="font-medium text-slate-900">
                    {selectedCustomer?.fullName ?? newCustomer.fullName}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Телефон</dt>
                  <dd className="text-slate-900">{selectedCustomer?.phone ?? newCustomer.phone}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Изделие</dt>
                  <dd className="text-slate-900">{item.name}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Работ: {works.length}</dt>
                  <dd className="text-slate-900">
                    {totalPositions} {plural(totalPositions, 'позиция', 'позиции', 'позиций')}
                  </dd>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-1.5">
                  <dt className="font-medium text-slate-900">Итого</dt>
                  <dd className="text-lg font-semibold text-slate-900">
                    {formatMinorExact(totalMinor)}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Магазин приёма" htmlFor="created-store" required>
                <Select
                  id="created-store"
                  value={effectiveCreatedStore}
                  onChange={(event) => setCreatedStoreId(event.target.value)}
                >
                  {availableStores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name} ({store.code})
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Магазин выдачи" htmlFor="pickup-store" required>
                <Select
                  id="pickup-store"
                  value={effectivePickupStore}
                  onChange={(event) => setPickupStoreId(event.target.value)}
                >
                  {/* По умолчанию совпадает с магазином приёма: клиент обычно
                      забирает изделие там же, где сдал. */}
                  {availableStores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name} ({store.code})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Цех" htmlFor="workshop" hint="Можно назначить позже">
                <Select
                  id="workshop"
                  value={workshopId}
                  onChange={(event) => setWorkshopId(event.target.value)}
                >
                  <option value="">Не назначен</option>
                  {(workshops ?? []).map((workshop) => (
                    <option key={workshop.id} value={workshop.id}>
                      {workshop.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Приоритет" htmlFor="priority">
                <Select
                  id="priority"
                  value={priority}
                  onChange={(event) =>
                    setPriority(event.target.value as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT')
                  }
                >
                  <option value="LOW">Низкий</option>
                  <option value="NORMAL">Обычный</option>
                  <option value="HIGH">Высокий</option>
                  <option value="URGENT">Срочный</option>
                </Select>
              </Field>
            </div>

            <Field label="Описание / пожелания клиента" htmlFor="description">
              <Textarea
                id="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4000}
              />
            </Field>

            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={requiresPrepayment}
                onChange={(event) => {
                  setRequiresPrepayment(event.target.checked);
                  if (!event.target.checked) setPrepayment('');
                  setError(null);
                }}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="text-sm text-slate-900">
                Требуется предоплата
                <span className="ml-1 text-xs text-slate-500">
                  (без неё старт работ будет заблокирован)
                </span>
              </span>
            </label>

            {requiresPrepayment ? (
              <Field
                label="Сумма предоплаты, ₽"
                htmlFor="prepayment"
                required
                error={
                  prepaymentInvalid
                    ? 'Больше суммы заказа'
                    : prepaymentMissing
                      ? 'Укажите сумму'
                      : undefined
                }
              >
                <Input
                  id="prepayment"
                  value={prepayment}
                  onChange={(event) => {
                    setPrepayment(event.target.value);
                    // Ошибку снимаем на вводе: иначе после исправления суммы
                    // красный текст «Больше суммы заказа» остаётся и вводит
                    // в заблуждение — заполнено верно, а форма «ругается».
                    setError(null);
                  }}
                  inputMode="decimal"
                  aria-invalid={prepaymentInvalid || prepaymentMissing}
                />
              </Field>
            ) : null}
          </div>
        ) : null}

        {error !== null ? <FormError>{error}</FormError> : null}

        <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-4">
          <div>
            {step > 0 ? (
              <Button type="button" variant="secondary" onClick={goBack}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Назад
              </Button>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            {step >= 3 && works.length > 0 ? (
              <span className="text-sm text-slate-500">
                Итого: <span className="font-medium text-slate-900">{formatMinor(totalMinor)}</span>
              </span>
            ) : null}

            {step < 4 ? (
              <Button type="button" onClick={goNext}>
                Далее
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button type="submit" loading={createOrder.isPending || createCustomer.isPending}>
                {createOrder.isPending ? 'Создаём…' : 'Создать заказ'}
              </Button>
            )}
          </div>
        </div>
      </form>

      <p className="text-center text-xs text-slate-400">
        {step === 4 ? (
          'Сумма рассчитана той же функцией, что и на сервере, поэтому совпадёт с заказом'
        ) : (
          <>
            <Badge tone="slate">черновик</Badge> Заказ создаётся целиком на последнем шаге — до
            этого данные никуда не отправляются
          </>
        )}
      </p>
    </div>
  );
}
