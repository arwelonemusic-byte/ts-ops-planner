import {
  FOOD_FALLBACK_EN,
  FOOD_FALLBACK_RU,
  NATO_PHONETIC,
  RUSSIAN_PHONETIC,
  START_FROM_ZERO,
} from "./markerDefaults";

export type MarkerSnapshot = {
  id: string;
  text: string;
  kind: "custom" | "military";
  iconQuad?: string;
  type?: string;
};

/** Stable per-type key. Custom markers key on iconQuad, military on type. */
export function typeKeyForMarker(m: MarkerSnapshot): string {
  return m.kind === "custom" ? `c:${m.iconQuad ?? ""}` : `m:${m.type ?? ""}`;
}

export function typeKeyForTemplate(
  args: { kind: "custom"; iconQuad: string } | { kind: "military"; type: string },
): string {
  return args.kind === "custom" ? `c:${args.iconQuad}` : `m:${args.type}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a matcher for the template's first `#` run. Every literal is escaped
 *  and each `#` run is substituted with a capturing `(\d+)` — but only the
 *  first capture is the counter; subsequent runs are reduced to non-capturing
 *  `\d+` so `.match()` returns a single group. */
function templateToCounterRegex(template: string): RegExp | null {
  if (!/#/.test(template)) return null;
  let out = "^";
  let seenFirst = false;
  let i = 0;
  while (i < template.length) {
    if (template[i] === "#") {
      let j = i;
      while (j < template.length && template[j] === "#") j++;
      out += seenFirst ? "\\d+" : "(\\d+)";
      seenFirst = true;
      i = j;
    } else {
      out += escapeRegex(template[i]);
      i++;
    }
  }
  out += "$";
  return new RegExp(out);
}

/** Next counter value for this type + template. */
function nextCounterForType(
  template: string,
  typeKey: string,
  iconQuad: string | undefined,
  markers: MarkerSnapshot[],
  excludeId: string | undefined,
): number {
  const re = templateToCounterRegex(template);
  const start = iconQuad && START_FROM_ZERO.has(iconQuad) ? 0 : 1;
  if (!re) return start;
  let max = -1;
  for (const m of markers) {
    if (m.id === excludeId) continue;
    if (typeKeyForMarker(m) !== typeKey) continue;
    const match = m.text.match(re);
    if (!match || match[1] === undefined) continue;
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max < 0 ? start : max + 1;
}

function firstUnusedFromPool(
  pool: readonly string[],
  usedText: string,
): string | null {
  for (const word of pool) {
    // Whole-word, case-sensitive substring match. Word boundaries use a manual
    // check so we don't depend on \b semantics for non-ASCII (Cyrillic).
    const idx = usedText.indexOf(word);
    if (idx === -1) return word;
    // Make sure it's a whole-word occurrence somewhere in `usedText`.
    const before = idx === 0 ? "" : usedText[idx - 1];
    const after = usedText[idx + word.length] ?? "";
    const isBoundary = (ch: string) => ch === "" || /[\s,.;:!?()\[\]{}"'\/\\-]/.test(ch);
    if (!isBoundary(before) || !isBoundary(after)) return word;
  }
  return null;
}

function pickPhonetic(
  primary: readonly string[],
  fallback: readonly string[],
  markers: MarkerSnapshot[],
  excludeId: string | undefined,
): string | null {
  // Concat everything so we can do one pass of indexOf per candidate.
  let joined = "";
  for (const m of markers) {
    if (m.id === excludeId) continue;
    joined += m.text + "\n";
  }
  // Filter candidates whose word appears as a whole token anywhere.
  const used = (word: string): boolean => {
    let from = 0;
    while (true) {
      const idx = joined.indexOf(word, from);
      if (idx === -1) return false;
      const before = idx === 0 ? "\n" : joined[idx - 1];
      const after = joined[idx + word.length] ?? "\n";
      const isBoundary = (ch: string) =>
        ch === "" || /[\s,.;:!?()\[\]{}"'\/\\-]/.test(ch);
      if (isBoundary(before) && isBoundary(after)) return true;
      from = idx + 1;
    }
  };
  for (const w of primary) if (!used(w)) return w;
  for (const w of fallback) if (!used(w)) return w;
  return null;
}

/** Substitute #, $, % tokens. `excludeId` omits one marker from the scan so
 *  re-resolving on edit doesn't count the edited marker's own old value. */
export function resolveMarkerText(
  template: string,
  typeKey: string,
  iconQuad: string | undefined,
  markers: MarkerSnapshot[],
  excludeId?: string,
): string {
  if (!/[#$%]/.test(template)) return template;

  let counter: number | null = null;
  const getCounter = () => {
    if (counter === null) {
      counter = nextCounterForType(template, typeKey, iconQuad, markers, excludeId);
    }
    return counter;
  };

  // For $ / %, draw fresh values per token inside the same template. Track
  // what we've assigned so two `$` in one template don't collide.
  const localUsed: string[] = [];
  const pickWith = (primary: readonly string[], fallback: readonly string[]): string | null => {
    const synthetic: MarkerSnapshot[] = localUsed.map((text, i) => ({
      id: `__local_${i}`,
      text,
      kind: "custom",
    }));
    const pool = [...markers.filter((m) => m.id !== excludeId), ...synthetic];
    return pickPhonetic(primary, fallback, pool, undefined);
  };

  return template.replace(/#+|\$|%/g, (tok) => {
    if (tok[0] === "#") {
      const n = getCounter();
      return String(n).padStart(tok.length, "0");
    }
    if (tok === "$") {
      const word = pickWith(NATO_PHONETIC, FOOD_FALLBACK_EN);
      if (word === null) return "$";
      localUsed.push(word);
      return word;
    }
    if (tok === "%") {
      const word = pickWith(RUSSIAN_PHONETIC, FOOD_FALLBACK_RU);
      if (word === null) return "%";
      localUsed.push(word);
      return word;
    }
    return tok;
  });
}
