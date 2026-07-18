"use client";

import { useEffect } from "react";
import { useT } from "@/components/LanguageProvider";
import type { Locale } from "@/lib/i18n";

type Section = { title: string; body: (string | string[])[] };
type Content = { title: string; intro: string; sections: Section[]; close: string };

const EN: Content = {
  title: "Help & Tutorial",
  intro:
    "This tool lets you plan operations on an Arma Reforger map and push the result into the game. Below is a quick tour of every feature — especially the non-obvious ones.",
  close: "Close",
  sections: [
    {
      title: "The three tools",
      body: [
        "The top-left tool strip switches between three tools. Each is explained in its own section below.",
        [
          "Marker (Q) — place icons, rotate them, label them, color them.",
          "Line (W) — draw a polyline. Click to add vertices, double-click to finish.",
          "Ruler (E) — measure distance and line-of-sight, or scan observation-point coverage.",
        ],
      ],
    },
    {
      title: "Keyboard shortcuts",
      body: [
        [
          "Q / W / E — switch to the Marker / Line / Ruler tool.",
          "Escape or Right-click — cancel an in-progress line draft or ruler measurement.",
          "Delete / Backspace — remove the currently selected marker or line.",
          "Scroll / + / − — zoom the map.",
          "Hold Shift while rotating a marker — 1° steps instead of 5°.",
          "Hold Ctrl while in any tool — quickly switch to line drawing mode",
          "Double-click while drawing a line — commits the line (minimum two vertices).",
        ],
      ],
    },
    {
      title: "Marker text: template variables",
      body: [
        "The marker Text field accepts three substitution tokens. They expand when the marker is placed, and re-expand when you edit an existing marker and blur the field.",
        [
          "# — auto-incrementing number, unique per icon. A run of # sets the minimum width (## = two digits minimum).",
          "$ — next unused NATO phonetic (Alpha, Bravo, Charlie…), unique per plan.",
          "% — next unused Russian phonetic (Анна, Борис, Василий…), unique per plan.",
        ],
        "Example: place a TRP with text \"TRP 1##\" — it becomes \"TRP 100\", then \"TRP 101\", etc. Place an SBF with text \"SBF $\" — it becomes \"SBF Alpha\", then \"SBF Bravo\", etc.",
        "TRP starts its counter at 0 (so the first TRP is 100 not 101). All other markers start at 1.",
        "When the NATO or Russian alphabets are exhausted within one plan, the tool falls back to 30 food names — treat it as a small easter egg.",
      ],
    },
    {
      title: "Marker text: per-icon defaults",
      body: [
        "Some icons auto-fill a useful template when you pick them. Switching icons always replaces the text with the new icon's default (or clears the field if that icon has no default):",
        [
          "TRP → \"TRP 1##\"",
          "WP / CP / MEP → \"#\"",
          "SBF / ABF → \"SBF $\" / \"ABF $\"",
          "AOA (any direction) → \"AOA $\"",
        ],
        "Icons without a default (like DESC or a vanilla dot) clear the field. Use the X button inside the Text field at any time to clear manually.",
      ],
    },
    {
      title: "Ruler: Line LOS",
      body: [
        "In Line Ruler mode, click two points to measure between them. The midpoint label shows distance and bearing.",
        "As soon as the first point is placed, a Line-of-Sight panel appears at the bottom of the screen. It draws a terrain profile from A to B and overlays a dashed sight line at 1.7 m eye height on both ends:",
        [
          "Green, unbroken — B is visible from A.",
          "Red with an X — terrain blocks the view; the X marks the first obstruction.",
        ],
      ],
    },
    {
      title: "Ruler: Radial LOS",
      body: [
        "The ruler panel has a Line Ruler / Radial LOS toggle. Radial LOS answers \"what can I see from this point?\" at a glance.",
        "Click once to place the observer, click again to set the circle radius. Inside the circle, areas hidden from the observer (1.7 m eye) are shaded 70% black. Uncovered areas are visible ground.",
        "Important caveat: a Line Ruler drawn from center to a distant hill might show \"visible\" while the valley behind that hill is shaded — both are correct. Radial LOS asks the question for every pixel, so ground hidden behind a ridge correctly shows as obstructed.",
      ],
    },
    {
      title: "Saving and sharing a plan",
      body: [
        "The yellow \"Push to Reforger\" button at the bottom saves your plan to the cloud and returns a 6-character code. Share that code with your teammates or paste it into the in-game admin console.",
        "The dots menu (top-right) also has:",
        [
          "Import Markers.layer — load a Workbench .layer file for read-only reference (initial markers from the mission maker).",
          "Import from code — load someone else's 6-character plan into your workspace.",
          "Clear all — wipe your plan (useful before pushing an empty plan to remove markers from the game).",
        ],
      ],
    },
    {
      title: "In-game",
      body: [
        "The TS Ops Planner mod must be running on the server. In-game, open the admin console and type:",
        [
          "/syncplan <code> — fetches the plan and spawns markers on the in-game map.",
        ],
        "Re-running /syncplan with a new code replaces the previous markers. Only Administrator, Session Admin, and Game Master roles may run the command.",
      ],
    },
    {
      title: "Maps and languages",
      body: [
        "The dots menu has a Map submenu to switch worlds, and a Language submenu (English / Русский). Your choices persist across sessions.",
      ],
    },
  ],
};

const RU: Content = {
  title: "Помощь и обучение",
  intro:
    "Этот инструмент помогает планировать операции на карте Arma Reforger и переносить готовый план в игру. Ниже — краткий обзор всех возможностей, особенно неочевидных.",
  close: "Закрыть",
  sections: [
    {
      title: "Три инструмента",
      body: [
        "В левом верхнем углу расположена панель с тремя инструментами. Каждый подробно описан ниже.",
        [
          "Маркер (Q) — размещение иконок с поворотом, подписью и цветом.",
          "Линия (W) — ломаная линия: клик добавляет вершину, двойной клик завершает её.",
          "Линейка (E) — измерение расстояния и видимости, а также оценка зоны обзора из выбранной точки.",
        ],
      ],
    },
    {
      title: "Горячие клавиши",
      body: [
        [
          "Q / W / E — выбор инструмента «Маркер» / «Линия» / «Линейка».",
          "Escape или правый клик — отмена текущего построения линии или измерения линейкой.",
          "Delete / Backspace — удалить выбранный маркер или линию.",
          "Колёсико мыши / + / − — масштабирование карты.",
          "Shift при вращении маркера — шаг 1° вместо 5°.",
          "Ctrl (или Cmd на macOS) в любом инструменте — быстрый переход в режим рисования линии.",
          "Двойной клик во время рисования линии — завершает линию (минимум две вершины).",
        ],
      ],
    },
    {
      title: "Текст маркера: переменные шаблона",
      body: [
        "Поле «Текст» у маркера поддерживает три подстановочных символа. Они заменяются при размещении маркера, а также при редактировании уже размещённого маркера — после того, как вы уйдёте из поля.",
        [
          "# — автоинкремент, уникальный в пределах одного типа иконки. Последовательность # задаёт минимальную ширину (## — минимум два знака).",
          "$ — следующий свободный позывной по алфавиту НАТО (Alpha, Bravo, Charlie…), уникальный в пределах плана.",
          "% — следующий свободный позывной по русскому алфавиту (Анна, Борис, Василий…), уникальный в пределах плана.",
        ],
        "Пример: разместите TRP с текстом «TRP 1##» — получится «TRP 100», затем «TRP 101» и так далее. Разместите SBF с текстом «SBF $» — получится «SBF Alpha», затем «SBF Bravo» и так далее.",
        "У TRP счётчик начинается с 0 (поэтому первый TRP — 100, а не 101). У остальных маркеров — с 1.",
        "Когда алфавит НАТО или русский заканчивается в пределах одного плана, подставляются 30 названий блюд — небольшая пасхалка.",
      ],
    },
    {
      title: "Текст маркера: значения по умолчанию",
      body: [
        "Некоторые иконки при выборе сами подставляют полезный шаблон в поле «Текст». Смена иконки всегда заменяет текст на шаблон новой иконки (или очищает поле, если шаблона нет):",
        [
          "TRP → «TRP 1##»",
          "WP / CP / MEP → «#»",
          "SBF / ABF → «SBF $» / «ABF $»",
          "AOA (в любую сторону) → «AOA $»",
        ],
        "У иконок без шаблона (DESC, стандартные иконки и т. п.) поле очищается. Кнопка × внутри поля «Текст» очищает его вручную в любой момент.",
      ],
    },
    {
      title: "Линейка: линия видимости",
      body: [
        "В режиме «Линейка» двумя кликами задаётся отрезок измерения. В середине отрезка отображаются расстояние и азимут.",
        "Сразу после первого клика в нижней части экрана появляется панель «Линия видимости». Она рисует профиль рельефа от точки A до точки B и накладывает пунктирную линию прицела на высоте 1,7 м на обоих концах:",
        [
          "Сплошная зелёная — точка B видна из точки A.",
          "Красная с крестиком — обзор перекрыт; крестик отмечает первое препятствие.",
        ],
      ],
    },
    {
      title: "Линейка: радиальная видимость",
      body: [
        "На панели линейки есть переключатель «Линейка» / «Радиальная видимость». «Радиальная видимость» отвечает на вопрос «что я вижу отсюда?» одним взглядом.",
        "Первый клик — положение наблюдателя, второй клик — радиус круга. Внутри круга участки, скрытые от наблюдателя (глаза на высоте 1,7 м), затеняются чёрным на 70 %. Незатенённые участки — видимая с этой точки местность.",
        "Важно: обычная «Линейка» может показать «видно» до вершины далёкого холма, а долина за этим холмом при этом окажется затенённой — и то, и другое верно. «Радиальная видимость» проверяет каждый пиксель, поэтому земля за гребнем корректно отображается как закрытая.",
      ],
    },
    {
      title: "Сохранение и передача плана",
      body: [
        "Жёлтая кнопка «Отправить в Reforger» внизу сохраняет план в облако и возвращает код из 6 символов. Передайте его соратникам или введите в админ-консоли в игре.",
        "Меню «…» (три точки в правом верхнем углу) также содержит:",
        [
          "«Импорт Markers.layer» — загрузить файл .layer из Workbench как справочный слой (начальные маркеры от автора миссии, только для чтения).",
          "«Импорт по коду» — загрузить чужой план по 6-символьному коду.",
          "«Очистить всё» — стереть текущий план (удобно перед отправкой пустого плана, чтобы убрать маркеры из игры).",
        ],
      ],
    },
    {
      title: "В игре",
      body: [
        "На сервере должен быть установлен и запущен мод TS Ops Planner. В игре откройте админ-консоль и введите команду:",
        [
          "/syncplan <код> — загружает план и создаёт маркеры на игровой карте.",
        ],
        "Повторный вызов /syncplan с другим кодом заменяет прежние маркеры. Команда доступна только ролям Administrator, Session Admin и Game Master.",
      ],
    },
    {
      title: "Карты и языки",
      body: [
        "В меню «…» есть подменю «Карта» для смены мира и «Язык» (English / Русский). Выбор сохраняется между сессиями.",
      ],
    },
  ],
};

const CONTENT: Record<Locale, Content> = { en: EN, ru: RU };

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { locale } = useT();
  const content = CONTENT[locale] ?? EN;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1800] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[720px] max-w-[92vw] max-h-[85vh] bg-[#202427] rounded-[12px] shadow-[0px_16px_32px_0px_rgba(0,0,0,0.5)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 pb-4 shrink-0">
          <h2 className="font-slab text-[24px] leading-[28px] text-white font-medium">
            {content.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-white/60 hover:text-white text-[18px] leading-none"
            aria-label={content.close}
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-6 pb-6 flex flex-col gap-5 text-[14px] leading-[22px] text-white/85">
          <p className="text-white/70">{content.intro}</p>
          {content.sections.map((s, si) => (
            <section key={si} className="flex flex-col gap-2">
              <h3 className="text-[16px] leading-[22px] text-[#f4db50] font-medium">
                {s.title}
              </h3>
              {s.body.map((b, bi) =>
                Array.isArray(b) ? (
                  <ul
                    key={bi}
                    className="list-disc pl-5 flex flex-col gap-1 marker:text-white/40"
                  >
                    {b.map((item, ii) => (
                      <li key={ii}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p key={bi}>{b}</p>
                ),
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
