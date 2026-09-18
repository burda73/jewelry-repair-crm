'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { History, Loader2, Plus, Save, Timer, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useCreateNormVersion, useCurrentNorms, useNormVersions } from '@/lib/queries';
import { describeApiError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, EmptyState } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, FormError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { formatDate } from '@/lib/format';
import type { NormEntryInput, NormItem, NormVersion } from '@/lib/api-types';

/** Право администратора: нормативы задают сроки, которые видит клиент. */
const SETTINGS_MANAGE = 'settings:manage';

/**
 * Названия этапов для интерфейса.
 *
 * Ключи — значения `NORM_STAGE` из домена. Если этап появится в домене, но не
 * здесь, таблица покажет сам код (`LOGISTICS_OUT`) вместо названия: это заметно
 * и не скрывает расхождение, тогда как подстановка «похожего» названия по
 * умолчанию сделала бы его незаметным.
 */
const STAGE_LABELS: Record<string, string> = {
  APPROVAL: 'Согласование клиента',
  PREPAYMENT: 'Ожидание предоплаты',
  QUEUE: 'Очередь на отправку',
  LOGISTICS_OUT: 'Доставка в цех',
  PRODUCTION: 'Производство',
  LOGISTICS_IN: 'Доставка в магазин',
  PICKUP: 'Хранение до выдачи',
  CLAIM: 'Рассмотрение рекламации',
};

/** Порядок этапов — как заказ проходит по ним, а не по алфавиту. */
const STAGE_ORDER = [
  'APPROVAL',
  'PREPAYMENT',
  'QUEUE',
  'LOGISTICS_OUT',
  'PRODUCTION',
  'LOGISTICS_IN',
  'PICKUP',
  'CLAIM',
];

const WORK_TYPE_LABELS: Record<string, string> = {
  ANY: 'любая',
  SIMPLE: 'типовой',
  COMPLEX: 'сложный',
};

const UNIT_LABELS: Record<string, { one: string; many: string; short: string }> = {
  WORKHOUR: { one: 'рабочий час', many: 'рабочих часа', short: 'раб. ч' },
  WORKDAY: { one: 'рабочий день', many: 'рабочих дня', short: 'раб. дн' },
  CALENDAR_DAY: { one: 'календарный день', many: 'календарных дня', short: 'кал. дн' },
};

const UNITS = ['WORKHOUR', 'WORKDAY', 'CALENDAR_DAY'];

/** Склонение названия единицы: «1 рабочий день», «3 рабочих дня». */
function unitLabel(unit: string, value: number): string {
  const forms = UNIT_LABELS[unit];
  if (!forms) return unit;
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return forms.one;
  return forms.many;
}

/** Понятная запись норматива: «24 рабочих часа». */
function describeNorm(norm: NormItem): string {
  return `${norm.value} ${unitLabel(norm.unit, norm.value)}`;
}

/**
 * Экран «Нормативы этапов» (задача 1.3.4, ТЗ п. 2.7).
 *
 * Экран построен вокруг ДВУХ идей, и обе определяют его вид:
 *
 *  1. Норматив — это НАБОР, а не отдельная строка. Правка не меняет значение на
 *     месте, а создаёт новую версию целиком, потому что по прежней версии
 *     объясняют сроки уже принятых заказов. Поэтому здесь нет «карандаша» у
 *     строки: есть редактируемый набор и кнопка «Сохранить как новую версию».
 *  2. Норматив измеряется в часах, днях или календарных днях, и это не
 *     косметика. «24 рабочих часа» и «3 рабочих дня» — разные сроки: рабочие
 *     часы считаются внутри окна 10:00–19:00, а рабочие дни — целыми днями по
 *     производственному календарю. Поэтому единица показывается рядом со
 *     значением и выбирается явно.
 *
 * Сроки, которые здесь задаются, видит клиент, и по ним считается просрочка
 * исполнителей, — отсюда предупреждение и обязательная причина изменения.
 */
export default function NormsPage(): ReactNode {
  const { can } = useAuth();
  // Ошибка показывается в форме (`FormError`), а не тостом: сообщение относится
  // к конкретным полям набора, и тост, исчезающий через несколько секунд, не
  // дал бы исправить ввод.
  const { showSuccess } = useToast();
  const canManage = can(SETTINGS_MANAGE);

  const current = useCurrentNorms();
  const versions = useNormVersions();
  const createVersion = useCreateNormVersion();

  /** Черновик набора: null — показываем действующую версию «как есть». */
  const [draft, setDraft] = useState<NormEntryInput[] | null>(null);
  const [reason, setReason] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * Отображаемый набор: черновик, если он есть, иначе действующая версия.
   *
   * Ключ строки — «этап + тип работ», а не индекс: при удалении строки из
   * середины индексы сдвигаются, и React переиспользовал бы поля не тех строк,
   * из-за чего введённое значение попадало бы в соседний этап.
   */
  const rows = useMemo<NormEntryInput[]>(() => {
    if (draft !== null) return draft;
    if (!current.data) return [];
    return current.data.norms.map((norm) => ({
      stage: norm.stage,
      workType: norm.workType,
      value: norm.value,
      unit: norm.unit,
      escalateToRole: norm.escalateToRole,
    }));
  }, [draft, current.data]);

  /** Набор упорядочен по ходу заказа: так его читают, а не по алфавиту. */
  const orderedRows = useMemo(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          const byStage = STAGE_ORDER.indexOf(a.row.stage) - STAGE_ORDER.indexOf(b.row.stage);
          if (byStage !== 0) return byStage;
          return a.row.workType.localeCompare(b.row.workType);
        }),
    [rows],
  );

  /** Изменён ли набор против действующей версии. */
  const isDirty = useMemo(() => {
    if (draft === null || !current.data) return draft !== null;
    const same =
      draft.length === current.data.norms.length &&
      draft.every((row) =>
        current.data?.norms.some(
          (norm) =>
            norm.stage === row.stage &&
            norm.workType === row.workType &&
            norm.value === row.value &&
            norm.unit === row.unit,
        ),
      );
    return !same;
  }, [draft, current.data]);

  function startEditing(): void {
    if (!current.data) {
      // Нормативов нет: набор начинается с пустого, а не с выдуманных значений.
      setDraft([]);
    } else {
      setDraft(
        current.data.norms.map((norm) => ({
          stage: norm.stage,
          workType: norm.workType,
          value: norm.value,
          unit: norm.unit,
          escalateToRole: norm.escalateToRole,
        })),
      );
    }
    setReason('');
    setEffectiveFrom('');
    setError(null);
  }

  function cancelEditing(): void {
    setDraft(null);
    setReason('');
    setError(null);
  }

  function updateRow(index: number, patch: Partial<NormEntryInput>): void {
    setDraft((prev) => {
      const base = prev ?? [];
      return base.map((row, i) => (i === index ? { ...row, ...patch } : row));
    });
  }

  function removeRow(index: number): void {
    setDraft((prev) => (prev ?? []).filter((_, i) => i !== index));
  }

  function addRow(): void {
    const used = new Set((draft ?? []).map((row) => `${row.stage}|${row.workType}`));
    // Этап выбирается первый свободный: иначе новая строка сразу дублировала бы
    // существующую пару, и сохранение отклонялось бы непонятной ошибкой.
    const stage = STAGE_ORDER.find((s) => !used.has(`${s}|ANY`)) ?? 'PRODUCTION';
    const workType = used.has(`${stage}|ANY`) ? 'SIMPLE' : 'ANY';
    setDraft([
      ...(draft ?? []),
      { stage, workType, value: 1, unit: 'WORKDAY', escalateToRole: null },
    ]);
  }

  async function submit(): Promise<void> {
    setError(null);
    const entries = draft ?? [];

    // Проверки повторяют серверные, чтобы объяснить ошибку до запроса: сервер
    // остаётся источником истины и проверяет то же самое.
    if (entries.length === 0) {
      setError('Добавьте хотя бы один норматив');
      return;
    }
    const keys = entries.map((row) => `${row.stage}|${row.workType}`);
    if (new Set(keys).size !== keys.length) {
      setError('Этап и тип работ повторяются в наборе');
      return;
    }
    if (entries.some((row) => !Number.isInteger(row.value) || row.value < 1 || row.value > 365)) {
      setError('Значение норматива — целое число от 1 до 365');
      return;
    }
    const production = entries.filter((row) => row.stage === 'PRODUCTION');
    const productionTypes = new Set(production.map((row) => row.workType));
    if (
      production.length > 0 &&
      !productionTypes.has('ANY') &&
      !(productionTypes.has('SIMPLE') && productionTypes.has('COMPLEX'))
    ) {
      setError('Для производства задайте общий норматив либо оба: типовой и сложный');
      return;
    }
    if (reason.trim().length < 5) {
      setError('Опишите причину изменения (не короче 5 символов)');
      return;
    }

    try {
      const created = await createVersion.mutateAsync({
        norms: entries,
        changeReason: reason.trim(),
        ...(effectiveFrom ? { effectiveFrom } : {}),
      });
      showSuccess(`Версия ${created.version} применена`);
      setDraft(null);
      setReason('');
      setEffectiveFrom('');
    } catch (caught) {
      setError(describeApiError(caught));
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            title="Недостаточно прав"
            hint="Нормативы этапов настраивает администратор: они задают сроки, которые видит клиент."
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Нормативы этапов</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Срок, который система обещает клиенту на каждом этапе. По нему считаются дата
            готовности, просрочка и эскалации. Изменение создаёт <strong>новую версию</strong>:
            прежняя остаётся в истории, чтобы можно было объяснить сроки уже принятых заказов.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setHistoryOpen(true)}>
            <History className="mr-2 h-4 w-4" />
            История версий
          </Button>
          {draft === null ? (
            <Button onClick={startEditing} disabled={current.isLoading}>
              <Plus className="mr-2 h-4 w-4" />
              Изменить нормативы
            </Button>
          ) : (
            <Button variant="secondary" onClick={cancelEditing}>
              Отменить
            </Button>
          )}
        </div>
      </div>

      {current.isLoading && (
        <Card>
          <CardBody>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загрузка нормативов…
            </div>
          </CardBody>
        </Card>
      )}

      {current.isError && (
        <Card>
          <CardBody>
            <FormError>{describeApiError(current.error)}</FormError>
          </CardBody>
        </Card>
      )}

      {!current.isLoading && current.data === null && (
        <Card>
          <CardBody>
            <div className="flex items-start gap-3">
              <Timer className="mt-0.5 h-5 w-5 text-amber-600" />
              <div>
                <div className="font-medium text-slate-900">Нормативы не заданы</div>
                <p className="mt-1 text-sm text-slate-600">
                  Пока набора нет, срок по этапам <strong>не рассчитывается</strong>: заказ
                  останется без даты готовности, и просрочку по нему система не увидит. Нажмите
                  «Изменить нормативы», чтобы задать набор.
                </p>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {(current.data !== null || draft !== null) && (
        <Card>
          <CardBody>
            {current.data && draft === null && (
              <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-600">
                <Badge tone="green">Версия {current.data.version}</Badge>
                <span>действует с {formatDate(current.data.effectiveFrom)}</span>
                {current.data.approvedAt && (
                  <span className="text-slate-500">
                    введена {formatDate(current.data.approvedAt)}
                  </span>
                )}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 pr-4 font-medium">Этап</th>
                    <th className="pb-2 pr-4 font-medium">Сложность</th>
                    <th className="pb-2 pr-4 font-medium">Срок</th>
                    <th className="pb-2 pr-4 font-medium">Единица</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {orderedRows.map(({ row, index }) => (
                    <tr key={`${row.stage}|${row.workType}`} className="border-b border-slate-100">
                      <td className="py-2 pr-4">
                        {draft === null ? (
                          <span className="text-slate-900">
                            {STAGE_LABELS[row.stage] ?? row.stage}
                          </span>
                        ) : (
                          <select
                            className="w-full rounded border border-slate-300 px-2 py-1"
                            value={row.stage}
                            onChange={(event) => updateRow(index, { stage: event.target.value })}
                          >
                            {STAGE_ORDER.map((stage) => (
                              <option key={stage} value={stage}>
                                {STAGE_LABELS[stage] ?? stage}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {draft === null ? (
                          <span className="text-slate-600">
                            {WORK_TYPE_LABELS[row.workType] ?? row.workType}
                          </span>
                        ) : (
                          <select
                            className="w-full rounded border border-slate-300 px-2 py-1"
                            value={row.workType}
                            onChange={(event) => updateRow(index, { workType: event.target.value })}
                          >
                            <option value="ANY">любая</option>
                            <option value="SIMPLE">типовой</option>
                            <option value="COMPLEX">сложный</option>
                          </select>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {draft === null ? (
                          <span className="font-medium text-slate-900">
                            {describeNorm(row as NormItem)}
                          </span>
                        ) : (
                          <Input
                            type="number"
                            min={1}
                            max={365}
                            value={row.value}
                            onChange={(event) =>
                              updateRow(index, { value: Number(event.target.value) })
                            }
                          />
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {draft === null ? (
                          <span className="text-slate-600">
                            {UNIT_LABELS[row.unit]?.short ?? row.unit}
                          </span>
                        ) : (
                          <select
                            className="w-full rounded border border-slate-300 px-2 py-1"
                            value={row.unit}
                            onChange={(event) => updateRow(index, { unit: event.target.value })}
                          >
                            {UNITS.map((unit) => (
                              <option key={unit} value={unit}>
                                {UNIT_LABELS[unit]?.short ?? unit}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {draft !== null && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="Удалить норматив"
                            onClick={() => removeRow(index)}
                          >
                            <Trash2 className="h-4 w-4 text-red-600" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {orderedRows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-slate-500">
                        В наборе нет ни одного норматива
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {draft !== null && (
              <div className="mt-4 space-y-4">
                <Button variant="secondary" onClick={addRow}>
                  <Plus className="mr-2 h-4 w-4" />
                  Добавить норматив
                </Button>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Причина изменения"
                    hint="Норматив меняет сроки всех новых заказов — причина попадёт в журнал действий"
                  >
                    <Input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Например: увеличили срок сложного ремонта до 20 дней"
                    />
                  </Field>
                  <Field label="Действует с" hint="По умолчанию — с сегодняшнего дня">
                    <Input
                      type="date"
                      value={effectiveFrom}
                      onChange={(event) => setEffectiveFrom(event.target.value)}
                    />
                  </Field>
                </div>

                {error && <FormError>{error}</FormError>}

                <div className="flex items-center gap-3">
                  <Button
                    onClick={() => {
                      void submit();
                    }}
                    disabled={createVersion.isPending || !isDirty}
                  >
                    {createVersion.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Сохранить как новую версию
                  </Button>
                  {!isDirty && <span className="text-sm text-slate-500">Набор не изменён</span>}
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          title="История версий нормативов"
          description="Прежние версии сохраняются, чтобы объяснить сроки уже принятых заказов."
        >
          {versions.isLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загрузка…
            </div>
          )}
          {versions.data?.length === 0 && (
            <p className="text-sm text-slate-600">Версий пока нет.</p>
          )}
          <div className="space-y-4">
            {versions.data?.map((version: NormVersion) => (
              <div key={version.version} className="rounded border border-slate-200 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <Badge tone={version.isActive ? 'green' : 'gray'}>Версия {version.version}</Badge>
                  {version.isActive && <span className="text-slate-600">действует</span>}
                  <span className="text-slate-500">
                    с {formatDate(version.effectiveFrom)}
                    {version.approvedAt ? `, введена ${formatDate(version.approvedAt)}` : ''}
                  </span>
                </div>
                <ul className="text-sm text-slate-700">
                  {version.norms
                    .slice()
                    .sort(
                      (a, b) =>
                        STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
                        a.workType.localeCompare(b.workType),
                    )
                    .map((norm) => (
                      <li key={norm.id} className="flex justify-between gap-4 py-0.5">
                        <span>
                          {STAGE_LABELS[norm.stage] ?? norm.stage}
                          {norm.workType !== 'ANY' && (
                            <span className="text-slate-500">
                              {' '}
                              ({WORK_TYPE_LABELS[norm.workType] ?? norm.workType})
                            </span>
                          )}
                        </span>
                        <span className="text-slate-600">{describeNorm(norm)}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
