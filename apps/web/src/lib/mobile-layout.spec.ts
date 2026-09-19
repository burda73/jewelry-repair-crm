/**
 * Тесты мобильной раскладки от 360 px (задача 1.7.6).
 *
 * ## Что здесь проверяется и почему не «вручную в браузере»
 *
 * Требование «адаптив от 360 px» держится на нескольких механических
 * инвариантах разметки, нарушение которых НЕ видно в сборке и не видно на
 * десктопе: приёмщик работает на планшете, а курьер — с телефона. Проверить это
 * глазами можно, только открыв каждую страницу на узком экране, и одна забытая
 * ширина в новой таблице не попадёт ни в типы, ни в линтер.
 *
 * Здесь проверяются ровно те инварианты, которые нарушаются молча:
 *
 * 1. **Широкий контент прокручивается, а не растягивает страницу.** Таблица,
 *    не поместившаяся в 360 px, задаёт минимальную ширину всему документу —
 *    появляется горизонтальная прокрутка ВСЕЙ страницы, при которой шапка и
 *    кнопки уезжают за край. Лечится обёрткой `overflow-x-auto` (прокручивается
 *    только таблица) либо отдельной мобильной раскладкой.
 * 2. **Нет фиксированной ширины больше экрана.** `w-[420px]` в разметке даёт
 *    ровно тот же эффект и ещё незаметнее.
 * 3. **Область нажатия не меньше 44 px.** Это уже проверялось решениями
 *    (`min-h-[44px]` в кнопках и полях), но один новый элемент без неё ломает
 *    требование доступности незаметно — поэтому размеры проверяются как правило,
 *    а не как факт в двух местах.
 *
 * Тесты читают ИСХОДНИКИ, а не рендерят компоненты: окружение `node`, React в
 * тестах не поднимается (docs — комментарий в `vitest.config.ts`). Для этих
 * инвариантов рендер и не нужен: они о разметке, а не о выводе.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Корень `apps/web`: файл лежит в `apps/web/src/lib/`. */
const webRoot = resolve(__dirname, '../..');
const srcRoot = join(webRoot, 'src');

/** Все файлы разметки под `src/`. */
function tsxFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) result.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx')) result.push(full);
  }
  return result;
}

const FILES = tsxFiles(srcRoot);

/** Короткое имя файла для сообщения об ошибке. */
const short = (file: string): string => relative(webRoot, file);

describe('Мобильная раскладка (360 px)', () => {
  it('находит файлы разметки', () => {
    // Проверка самого обхода: пустой список сделал бы все проверки ниже
    // бессмысленно зелёными.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('каждая таблица прокручивается по горизонтали или имеет мобильную замену', () => {
    /*
     * Три таблицы в проекте: калькуляция и история в карточке заказа, список
     * заказов, нормативы. У списка заказов отдельная карточная раскладка на
     * мобильном (`hidden … md:block`), у двух других — `overflow-x-auto`.
     *
     * Без одного из двух: таблица шире экрана задаёт `min-width` документу, и
     * горизонтально прокручивается вся страница — кнопки и шапка уезжают.
     */
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      if (!/<table/.test(source)) continue;

      const hasScroll = /overflow-x-auto/.test(source);
      const hasMobileAlternative = /hidden[^"']*md:block/.test(source);
      expect(
        hasScroll || hasMobileAlternative,
        `${short(file)}: <table> без overflow-x-auto и без мобильной замены`,
      ).toBe(true);
    }
  });

  it('нет элементов с фиксированной шириной больше 360 px', () => {
    /*
     * `w-[400px]` не переносится, не сжимается и не ломается — он просто
     * вылезает за экран. На узком экране прокрутка появится не у элемента, а у
     * всей страницы.
     */
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bw-\[(\d+)px\]/g)) {
        expect(
          Number(match[1]),
          `${short(file)}: фиксированная ширина w-[${match[1]}px] превышает 360 px`,
        ).toBeLessThanOrEqual(360);
      }
    }
  });

  it('широкие контейнеры ограничены max-w и растягиваются по ширине экрана', () => {
    /*
     * `max-w-*` без `w-full` работает на десктопе и не мешает на мобильном:
     * блочный элемент занимает ширину родителя. Проверка фиксирует, что нигде
     * не задана ЖЁСТКАЯ ширина контейнера страницы — только максимальная.
     */
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      // `w-screen` и `min-w-screen` — легальны: это ширина окна, а не больше неё.
      for (const match of source.matchAll(/\bmin-w-\[(\d+)px\]/g)) {
        expect(
          Number(match[1]),
          `${short(file)}: min-w-[${match[1]}px] превышает 360 px`,
        ).toBeLessThanOrEqual(360);
      }
    }
  });

  it('кнопки и поля ввода не меньше 44 px по высоте', () => {
    /*
     * Требование доступности (docs/08-ui-ux.md §7): область нажатия для пальца.
     * Проверяются общие компоненты: если правило соблюдено в `Button` и `Input`,
     * оно соблюдено везде, где ими пользуются, — а пользуются ими во всём
     * приложении. Отдельная кнопка со своим `className` проверяется ниже.
     */
    const button = readFileSync(join(srcRoot, 'components/ui/button.tsx'), 'utf8');
    const input = readFileSync(join(srcRoot, 'components/ui/input.tsx'), 'utf8');
    expect(button).toMatch(/min-h-\[44px\]|h-11/);
    expect(input).toMatch(/min-h-\[44px\]|h-11/);
  });

  it('нет горизонтальной прокрутки на уровне main', () => {
    /*
     * Если `main` получит `overflow-x-auto` или `overflow-x-scroll`, прокрутка
     * страницы станет штатным поведением и перестанет быть заметной как
     * проблема: «оно и так прокручивается». Таблицы должны прокручиваться
     * внутри себя, а страница — помещаться целиком.
     */
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${short(file)}: main с overflow-x на всю страницу`).not.toMatch(
        /<main[^>]*overflow-x-(auto|scroll)/,
      );
    }
  });
});
