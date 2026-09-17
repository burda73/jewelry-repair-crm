'use client';

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Camera, Loader2, Trash2 } from 'lucide-react';
import { useItemPhotos, useUploadPhoto, useDeletePhoto } from '@/lib/queries';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/toast';
import { describeApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/** Виды фото. Значения совпадают с сервером (`PHOTO_KINDS`). */
const PHOTO_KINDS = [
  { value: 'INTAKE', label: 'При приёме' },
  { value: 'DEFECT', label: 'Дефект' },
  { value: 'RESULT', label: 'Результат' },
  { value: 'AFTER_REPAIR', label: 'После ремонта' },
] as const;

type PhotoKind = (typeof PHOTO_KINDS)[number]['value'];

/**
 * Фотографии изделия (ТЗ п. 2.1).
 *
 * Снимок привязан к конкретному изделию, а не к заказу: в заказе может быть
 * несколько предметов, и фото «вообще» не сказало бы, к какому из них оно
 * относится.
 *
 * Файлы не отправляются по одному: приёмщик фотографирует изделие с нескольких
 * ракурсов и не должен ждать по кругу. Загрузка идёт одним запросом, а сервер
 * перекодирует изображения и делает уменьшенные копии для списка.
 */
export function ItemPhotos({
  item,
  orderId,
  canUpload,
}: {
  item: { id: string; name: string; photos: { id: string }[] };
  orderId: string;
  canUpload: boolean;
}): ReactNode {
  const { can } = useAuth();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<PhotoKind>('INTAKE');

  const photos = useItemPhotos(orderId, item.id);
  const upload = useUploadPhoto(orderId, item.id);
  const remove = useDeletePhoto(orderId, item.id);

  const canDelete = can('order:update');
  const list = photos.data ?? [];

  async function handleFiles(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    // Поле очищается сразу: иначе повторный выбор того же файла не вызовет
    // `change`, и сотрудник решит, что загрузка не сработала.
    event.target.value = '';
    if (files.length === 0) return;

    try {
      await upload.mutateAsync({ files, kind });
    } catch (error) {
      toast.showError(describeApiError(error));
    }
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          Фото {list.length > 0 ? `(${list.length})` : ''}
        </span>

        {canUpload ? (
          <div className="flex items-center gap-1.5">
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as PhotoKind)}
              aria-label="Вид фотографии"
              className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-700"
            >
              {PHOTO_KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={upload.isPending}
              className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {upload.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <Camera className="h-3 w-3" aria-hidden="true" />
              )}
              {upload.isPending ? 'Загрузка…' : 'Добавить'}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              multiple
              // `capture` не задан намеренно: на планшете сотрудник должен иметь
              // выбор — снять сейчас или выбрать готовый снимок.
              onChange={(event) => void handleFiles(event)}
              className="hidden"
            />
          </div>
        ) : null}
      </div>

      {photos.isLoading ? (
        <p className="text-xs text-slate-400">Загрузка фотографий…</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-slate-400">
          {canUpload ? 'Фотографии не добавлены' : 'Фотографий нет'}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {list.map((photo) => (
            <li key={photo.id} className="group relative">
              <a
                href={photo.url}
                target="_blank"
                rel="noreferrer"
                title={photo.caption ?? undefined}
                className="block overflow-hidden rounded border border-slate-200"
              >
                {/*
                  Обычный `img`, а не `next/image`: файл отдаётся API с
                  `Cache-Control: private, no-store` и требует cookie, поэтому
                  оптимизатор Next не смог бы его получить.

                  `loading="lazy"` НЕ используется. Уменьшенная копия весит
                  меньше килобайта (320 px, JPEG), а отложенная загрузка
                  опирается на `IntersectionObserver`: там, где он не срабатывает
                  (headless-браузер, часть встроенных просмотрщиков), фотографии
                  не появляются вовсе — сотрудник видит пустые рамки. Экономия
                  в несколько килобайт не стоит того, чтобы фотофиксация
                  «иногда не работала».
                */}
                <img
                  src={photo.thumbnailUrl}
                  alt={photo.caption ?? 'Фотография изделия'}
                  width={64}
                  height={64}
                  className="h-16 w-16 object-cover"
                />
              </a>
              {canDelete ? (
                <button
                  type="button"
                  onClick={() => remove.mutate(photo.id)}
                  disabled={remove.isPending}
                  aria-label="Удалить фотографию"
                  className={cn(
                    'absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full',
                    'bg-white text-red-600 shadow ring-1 ring-slate-200 hover:bg-red-50',
                    'group-hover:flex focus:flex disabled:opacity-50',
                  )}
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
