"use client";

// Event log panel that renders under the main replay panel. Derives a
// flat, sortable stream of log entries from the replayIdx (player joins +
// damage_state→destroyed transitions for player-controlled chars), then
// scrolls with the playhead. Clicking an entry seeks playback to that
// event. Auto-sync flips off the moment the user scrolls manually; a
// directional resync button restores it (anchored top or bottom based on
// which way the playhead has drifted relative to the viewport). New
// events get a 1-second yellow flash as they arrive at the top of the
// visible area.
//
// Killer attribution: each "killed" entry is enriched with the killer's
// player name when the mod's `kill` event carries one (player-driven kill).
// Same-team kills live under the same "killed" filter as enemy kills, but
// flip the skull icon to friendly-blue so commanders can scan the row at
// a glance and spot friendly-fire incidents. AI-killer deaths fall back
// to the plain "{name} killed" verb when the killer can't be named.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/components/LanguageProvider";
import { MaskIcon } from "@/components/MarkerIcon";
import {
  DAMAGE_DESTROYED,
  DAMAGE_INTERMEDIARY,
  type ReplayIndex,
} from "@/lib/replay";

// "incapacitated" = INCAPACITATED (state=1, recoverable, yellow icon).
// "killed" = DEAD (state=2, terminal, red skull — or blue when same-team,
// see isTeamKill). "connect" = roster join (green). Legacy replays only
// carry state=2 (the mod used to collapse incap + dead), so old data shows
// up as "killed" only — the closest surviving label for "this player is
// out of action" in the pre-split era.
type LogCategory = "incapacitated" | "killed" | "connect";

type LogEntry = {
  /** Stable React key. */
  key: string;
  /** Mod-side absolute timestamp (matches playbackTime + replayIdx.firstT). */
  t: number;
  /** Display offset from session start (ms), for the MM:SS column. */
  localT: number;
  category: LogCategory;
  /** Name to plug into the localized message template. Distinct from the
   *  category so a future locale swap doesn't force re-deriving the array. */
  subjectName: string;
  /** Killer's player name when the mod's `kill` event identified a player
   *  killer. null when the killer is AI / environment / unknown. Drives
   *  the "killed by {killer}" verb choice. */
  killerName: string | null;
  /** True when a named player killed a same-team target. Flips the skull
   *  icon to friendly-blue so the row reads as a friendly-fire incident
   *  without forcing the viewer onto a separate filter. */
  isTeamKill: boolean;
  /** Char to focus the map on when this entry is clicked. Direct for death
   *  events (the body that went down); for connect events, walked from
   *  possesses to the player's first possessed char. Null when no char is
   *  resolvable (player connected but never picked a slot). */
  focusCharId: number | null;
};

const FLASH_MS = 1000;

// Brand-aligned tints. Matches the source SVGs' intended colors so the
// recolor-via-CSS-mask doesn't fight the intent: yellow-amber for incap
// (recoverable), red for killed (terminal), green for connect (positive
// roster activity).
const COLOR_INCAP = "#E5B93F";
const COLOR_KILLED = "#DA6B50";
const COLOR_CONNECT = "#4ADE80";
// Friendly-blue for the skull icon when the killer is on the same team as
// the victim. Matches HEX_FRIENDLY in replay.ts so the visual reads as
// "our side did this" without needing a second filter row.
const COLOR_TEAMKILL_ICON = "#3b82f6";

function formatDurationMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Detect Game Master takeover chars — AI bodies that a GM possessed mid-life
 *  (rather than the engine spawning a fresh body for a connecting player).
 *  Signature: the char has both an `isPlayerControlled: false` register AND
 *  an `isPlayerControlled: true` register at *different* timestamps. Normal
 *  player spawns emit both registers in the same OnInit chain (same `t`),
 *  so equal timestamps mean "fresh spawn, not a takeover".
 *
 *  We suppress incap + killed log entries for takeover chars because the
 *  GM's possession is logistical, not roleplay — when their AI body goes
 *  down, the commander reading the log doesn't care that "Galaxy" (the GM)
 *  was killed, they care about the actual combat events. The real kill is
 *  still attributable to the shooter via the regular kill event chain. */
function buildGmTakeoverCharIds(idx: ReplayIndex): Set<number> {
  const firstAiT = new Map<number, number>();
  const firstPcT = new Map<number, number>();
  for (const ev of idx.data.events) {
    if (ev.type !== "char_register") continue;
    const target = ev.isPlayerControlled ? firstPcT : firstAiT;
    if (!target.has(ev.charId)) target.set(ev.charId, ev.t);
  }
  const out = new Set<number>();
  for (const [charId, aiT] of firstAiT) {
    const pcT = firstPcT.get(charId);
    if (pcT !== undefined && pcT !== aiT) out.add(charId);
  }
  return out;
}

/** Phantom-char detector for legacy replays recorded before the mod-side
 *  holder filter landed. After death, the engine briefly attaches a dead
 *  player to placeholder ChimeraCharacter entities at world origin (the
 *  spawn-menu preview / spectator-cam target) and cycles through several
 *  of them as the player navigates the death screen. Each holder's cleanup
 *  emits a damage_state=DESTROYED, producing fake "killed" entries in the
 *  log. Signature: every move event is within 5m of world origin (real
 *  chars never spawn that close to (0,0)). New recordings drop these
 *  events at the source via TS_ReplayPlayerController's faction-empty
 *  early-return; this filter retroactively cleans pre-fix replays. */
function isPhantomChar(charId: number, idx: ReplayIndex): boolean {
  const moves = idx.movesByChar.get(charId);
  if (!moves || moves.length === 0) return false;
  for (const m of moves) {
    if (Math.abs(m.x) > 5 || Math.abs(m.z) > 5) return false;
  }
  return true;
}

/** Walk possess events once to produce charId → latest-known player name.
 *  Used as the death-message subject. Latest-wins because the same body
 *  can be possessed by different players across a session (player swaps
 *  to a fresh character after dying / respawning into a new slot). */
function buildCharNameMap(idx: ReplayIndex): Map<number, string> {
  const m = new Map<number, string>();
  for (const ev of idx.possesses) {
    if (ev.charId === 0) continue; // depossess; doesn't bind a new name
    const name = idx.playerNames.get(ev.playerId);
    if (name) m.set(ev.charId, name);
  }
  return m;
}

/** Pre-build playerId → first-possessed charId in one pass. Used to
 *  resolve a focus target for connect events — the player has no body at
 *  the connect moment, so we pan to wherever their first slot pick lands.
 *  Players who connect but never possess a char get a null focusCharId. */
function buildFirstCharByPlayer(idx: ReplayIndex): Map<number, number> {
  const m = new Map<number, number>();
  for (const ev of idx.possesses) {
    if (ev.charId === 0) continue;
    if (!m.has(ev.playerId)) m.set(ev.playerId, ev.charId);
  }
  return m;
}

function buildLogEntries(idx: ReplayIndex): LogEntry[] {
  const out: LogEntry[] = [];
  const firstCharByPlayer = buildFirstCharByPlayer(idx);

  // Connections — straight from player_join events. The web-side trim
  // rebases pre-T0 joins to firstT, so legacy late-joiners appear at 0:00
  // rather than being hidden behind dead air.
  for (const ev of idx.data.events) {
    if (ev.type === "player_join") {
      out.push({
        key: `connect-${ev.playerId}-${ev.t}`,
        t: ev.t,
        localT: Math.max(0, ev.t - idx.firstT),
        category: "connect",
        subjectName: ev.name,
        killerName: null,
        isTeamKill: false,
        focusCharId: firstCharByPlayer.get(ev.playerId) ?? null,
      });
    }
  }

  // Down + killed events derived from the per-char damage_state stream.
  // The mod now distinguishes INCAPACITATED (1) from DEAD (2); legacy
  // replays only carry 0 / 2, so old data surfaces purely as "killed".
  //   prev != 1, next == 1  → "down" entry  (player went incap)
  //   prev != 2, next == 2  → "killed" entry (player died — directly or
  //                            via bleed-out from incap)
  // AI lives are filtered via friendlyCharIds to avoid drowning the log.
  //
  // Incap → death within INCAP_TO_DEATH_COLLAPSE_MS suppresses the incap
  // entry — a quick bleed-out / finishing shot reads as a single "killed"
  // event, not a noisy incap+killed pair the viewer has to mentally merge.
  const INCAP_TO_DEATH_COLLAPSE_MS = 5000;
  const charNameByCharId = buildCharNameMap(idx);
  const gmTakeoverCharIds = buildGmTakeoverCharIds(idx);
  for (const [charId, damages] of idx.damageByChar) {
    if (!idx.friendlyCharIds.has(charId)) continue;
    if (gmTakeoverCharIds.has(charId)) continue;
    if (isPhantomChar(charId, idx)) continue;
    const name = charNameByCharId.get(charId);
    if (!name) continue;
    let prev = 0;
    for (let i = 0; i < damages.length; i++) {
      const ev = damages[i];
      if (ev.state === DAMAGE_INTERMEDIARY && prev !== DAMAGE_INTERMEDIARY) {
        // Look ahead: if a death lands within the collapse window with no
        // intervening revive, drop this incap entry.
        let collapsed = false;
        for (let j = i + 1; j < damages.length; j++) {
          const nxt = damages[j];
          if (nxt.t - ev.t > INCAP_TO_DEATH_COLLAPSE_MS) break;
          if (nxt.state === DAMAGE_DESTROYED) {
            collapsed = true;
            break;
          }
          if (nxt.state === 0) break; // revived — keep the incap entry
        }
        if (!collapsed) {
          out.push({
            key: `incap-${charId}-${ev.t}`,
            t: ev.t,
            localT: Math.max(0, ev.t - idx.firstT),
            category: "incapacitated",
            subjectName: name,
            killerName: null,
            isTeamKill: false,
            focusCharId: charId,
          });
        }
      } else if (ev.state === DAMAGE_DESTROYED && prev !== DAMAGE_DESTROYED) {
        // Enrich with killer attribution from the `kill` event (mod side).
        // The kill event is emitted at OnControllableDestroyed time, which
        // can land slightly after damage_state=DESTROYED — but there's only
        // one terminal death per char per spawn, so keying by victimCharId
        // is unambiguous regardless of which event arrived first on the
        // wire. AI-on-friendly kills (no playerName for killer) fall back to
        // the plain "killed" verb, matching pre-attribution behavior. TK
        // flag is only set when a named player is responsible — AI-on-
        // friendly-AI same-faction kills are noise (faction-compare would
        // flag them but they're not actionable for review).
        const kill = idx.killByVictimCharId.get(charId);
        let killerName: string | null = null;
        let isTeamKill = false;
        if (kill && kill.killerPlayerId > 0) {
          killerName = idx.playerNames.get(kill.killerPlayerId) ?? null;
          isTeamKill = !!(kill.isTeamKill && killerName);
        }
        out.push({
          key: `killed-${charId}-${ev.t}`,
          t: ev.t,
          localT: Math.max(0, ev.t - idx.firstT),
          category: "killed",
          subjectName: name,
          killerName,
          isTeamKill,
          focusCharId: charId,
        });
      }
      prev = ev.state;
    }
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Binary-search the last entry whose t ≤ targetT. Returns -1 when every
 *  entry is in the future (nothing has happened yet). */
function findLatestPastIndex(entries: LogEntry[], targetT: number): number {
  if (entries.length === 0) return -1;
  if (entries[0].t > targetT) return -1;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid].t <= targetT) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function ReplayEventLog({
  replayIdx,
  playbackTime,
  onPickEvent,
  expanded,
  onToggleExpanded,
}: {
  replayIdx: ReplayIndex;
  playbackTime: number;
  /** Click handler for a log entry. Seeks playback to `localT` and pans
   *  the map to the player's `focusCharId` when one is available. */
  onPickEvent: (localT: number, focusCharId: number | null) => void;
  /** Lifted state so the parent can grow the wrapper to fill the viewport
   *  only when the log is expanded. */
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { t } = useT();
  // Three independent filter pills: incapacitated (recoverable down),
  // killed (terminal), connect (roster joins). Connect ships off because
  // most viewers care about combat events; the other two are on by
  // default since they're the primary signal.
  const [filters, setFilters] = useState<Record<LogCategory, boolean>>({
    incapacitated: true,
    killed: true,
    connect: false,
  });
  const [autoSync, setAutoSync] = useState(true);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  // "up" means the playhead anchor is above the visible area; "down" means
  // it's below. Used to position the resync button (and rotate its arrow).
  const [resyncDirection, setResyncDirection] = useState<"up" | "down">("down");
  // Hide the resync button outright when the anchor is currently in view.
  const [anchorVisible, setAnchorVisible] = useState(true);

  const allEntries = useMemo(() => buildLogEntries(replayIdx), [replayIdx]);
  const visibleEntries = useMemo(
    () => allEntries.filter((e) => filters[e.category]),
    [allEntries, filters],
  );

  // Current entry = latest entry with t ≤ playhead. Used as the scroll
  // anchor when autoSync is true, and to gate the "new-event" highlight.
  const playheadT = playbackTime + replayIdx.firstT;
  const currentIdx = useMemo(
    () => findLatestPastIndex(visibleEntries, playheadT),
    [visibleEntries, playheadT],
  );
  const currentKey =
    currentIdx >= 0 ? visibleEntries[currentIdx].key : null;

  // Flash the entry as it becomes current. Skip the initial mount so we
  // don't briefly highlight the first past event when the log first
  // expands or the user loads a replay mid-session.
  const prevCurrentKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevCurrentKeyRef.current = currentKey;
      return;
    }
    if (currentKey && currentKey !== prevCurrentKeyRef.current) {
      setHighlightedKey(currentKey);
      const id = setTimeout(() => setHighlightedKey(null), FLASH_MS);
      prevCurrentKeyRef.current = currentKey;
      return () => clearTimeout(id);
    }
    prevCurrentKeyRef.current = currentKey;
  }, [currentKey]);

  // Refs for scroll sync.
  const listRef = useRef<HTMLDivElement | null>(null);
  const entryRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  // Gate so onScroll can distinguish our scrollIntoView call from a user
  // wheel/touch scroll. Cleared 120ms later — long enough for the browser
  // to fire the resulting scroll event, short enough that a real user
  // scroll on the very next frame still flips autoSync off.
  const programmaticScrollRef = useRef(false);

  /** Visibility + direction of the playhead anchor relative to the
   *  scrollable viewport. Driven on every scroll event and whenever the
   *  current entry changes. */
  function recomputeAnchorPosition() {
    const list = listRef.current;
    if (!list || currentIdx < 0) {
      setAnchorVisible(true);
      return;
    }
    const anchorEl = entryRefs.current.get(visibleEntries[currentIdx].key);
    if (!anchorEl) {
      setAnchorVisible(true);
      return;
    }
    const anchorTop = anchorEl.offsetTop;
    const anchorBottom = anchorTop + anchorEl.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (anchorBottom <= viewTop) {
      setResyncDirection("up");
      setAnchorVisible(false);
    } else if (anchorTop >= viewBottom) {
      setResyncDirection("down");
      setAnchorVisible(false);
    } else {
      setAnchorVisible(true);
    }
  }

  useLayoutEffect(() => {
    if (!expanded) return;
    if (!autoSync) {
      // Just recompute the resync button direction relative to the new
      // anchor without scrolling.
      recomputeAnchorPosition();
      return;
    }
    if (currentIdx < 0) return;
    const key = visibleEntries[currentIdx].key;
    const el = entryRefs.current.get(key);
    const list = listRef.current;
    if (!el || !list) return;
    programmaticScrollRef.current = true;
    // Anchor the current entry at the top of the visible area so future
    // events read as "coming next" below it.
    list.scrollTop = el.offsetTop - list.offsetTop;
    const tid = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 120);
    setAnchorVisible(true);
    return () => clearTimeout(tid);
    // recomputeAnchorPosition is stable enough; listing it would force the
    // effect to fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, autoSync, currentIdx, visibleEntries]);

  function handleScroll() {
    if (programmaticScrollRef.current) return;
    if (autoSync) setAutoSync(false);
    recomputeAnchorPosition();
  }

  function toggleFilter(cat: LogCategory) {
    setFilters((prev) => ({ ...prev, [cat]: !prev[cat] }));
    // Filter change reshuffles the list; bring the playhead back into view.
    setAutoSync(true);
  }

  function handleEntryClick(entry: LogEntry) {
    onPickEvent(entry.localT, entry.focusCharId);
    // After seeking, currentIdx will land on (or near) this entry, so
    // autoSync re-anchoring is the desired behavior.
    setAutoSync(true);
  }

  // Per Figma 68:262 the panel is a two-section card: outer (rounded
  // #14181a) wraps a #202427 header card sitting above a bare list
  // region. Outer carries the shadow + rounding; overflow-hidden clips
  // the header back to flush against the list. When expanded, the chrome
  // flex-grows to fill the remaining sidebar height; collapsed, it sizes
  // to the header alone.
  const chromeClass = expanded
    ? "bg-[#14181a] rounded-[12px] overflow-hidden flex flex-col shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] flex-1 min-h-0"
    : "bg-[#14181a] rounded-[12px] overflow-hidden flex flex-col shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)]";

  return (
    <div className={chromeClass}>
      {/* Header card — bg-#202427 with a bottom #2e3439 hairline that
          separates it from the list region. Locked to 60px tall in both
          states so expanding doesn't visually jolt the panel as the
          filter pills (28px) become visible alongside the text (20px).
          Container is a div (not button) because the filter pills are
          nested <button> elements and HTML disallows button-in-button.
          Keyboard accessibility preserved via role="button" + Enter/Space
          handler; click anywhere on the header that isn't a filter pill
          toggles expansion. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpanded();
          }
        }}
        aria-expanded={expanded}
        aria-label={expanded ? t("eventLog.collapse") : t("eventLog.expand")}
        className={`flex items-center gap-4 w-full shrink-0 bg-[#202427] px-5 h-[60px] cursor-pointer ${
          expanded ? "border-b border-[#2e3439]" : ""
        }`}
      >
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <MaskIcon
            src="/icons/figma/list.svg"
            size={16}
            color="#f4db50"
          />
          <span className="text-[14px] leading-[20px] text-white/60">
            {t("eventLog.title")}
          </span>
        </div>
        {expanded && (
          // Filter pills capture their own clicks so the surrounding
          // header doesn't toggle when a filter is flipped.
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <FilterPill
              active={filters.incapacitated}
              onClick={() => toggleFilter("incapacitated")}
              ariaLabel={t("eventLog.filter.incapacitated")}
              iconSrc="/icons/figma/incapacitated.svg"
            />
            <FilterPill
              active={filters.killed}
              onClick={() => toggleFilter("killed")}
              ariaLabel={t("eventLog.filter.deaths")}
              iconSrc="/icons/figma/skull.svg"
            />
            <FilterPill
              active={filters.connect}
              onClick={() => toggleFilter("connect")}
              ariaLabel={t("eventLog.filter.connections")}
              iconSrc="/icons/figma/connection.svg"
            />
          </div>
        )}
        <MaskIcon
          src={expanded ? "/icons/figma/chevron-up.svg" : "/icons/figma/chevron-down.svg"}
          size={16}
          color="rgba(255,255,255,0.6)"
        />
      </div>

      {expanded && (
        <div className="flex-1 min-h-0 relative flex flex-col">
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="ts-thin-scrollbar flex-1 min-h-0 overflow-y-auto flex flex-col p-2"
          >
            {visibleEntries.length === 0 && (
              <div className="px-3 py-4 text-[14px] leading-[20px] text-white/40 text-center">
                {t("eventLog.empty")}
              </div>
            )}
            {visibleEntries.map((entry) => {
              const isPast = entry.t <= playheadT;
              const isFlash = entry.key === highlightedKey;
              // Per-category icon + color. Incap and killed are
              // semantically distinct now (recoverable vs terminal) and
              // get their own glyph + tint so the eye can scan the log
              // and see at a glance whose status went which way.
              let iconSrc: string;
              let iconColor: string;
              let verb: string;
              if (entry.category === "incapacitated") {
                iconSrc = "/icons/figma/incapacitated.svg";
                iconColor = COLOR_INCAP;
                verb = t("eventLog.verb.incapacitated");
              } else if (entry.category === "killed") {
                iconSrc = "/icons/figma/skull.svg";
                // Blue skull when a same-team named player did it — visual-
                // only differentiator per the Figma 68:667 spec (same row
                // layout, same verb, just the icon flips). Red otherwise.
                iconColor = entry.isTeamKill ? COLOR_TEAMKILL_ICON : COLOR_KILLED;
                verb = entry.killerName
                  ? t("eventLog.verb.killedBy", { killer: entry.killerName })
                  : t("eventLog.verb.killed");
              } else {
                iconSrc = "/icons/figma/connection.svg";
                iconColor = COLOR_CONNECT;
                verb = t("eventLog.verb.connected");
              }
              return (
                <button
                  key={entry.key}
                  ref={(el) => {
                    if (el) entryRefs.current.set(entry.key, el);
                    else entryRefs.current.delete(entry.key);
                  }}
                  type="button"
                  onClick={() => handleEntryClick(entry)}
                  className={`group flex items-center gap-2 p-3 rounded-[4px] text-left transition-colors hover:bg-white/5 ${
                    isFlash ? "log-flash" : ""
                  } ${isPast ? "" : "opacity-50"}`}
                >
                  <span className="shrink-0 flex items-center justify-center w-[16px] h-[16px]">
                    <MaskIcon src={iconSrc} size={16} color={iconColor} />
                  </span>
                  {/* Two-tone body: name in primary white, verb in
                      white/60 so the subject pops while the action stays
                      muted — matches the Figma "{name} connected" /
                      "{name} is down" treatment. */}
                  <span
                    className="flex-1 min-w-0 text-[14px] leading-[20px] truncate"
                    title={`${entry.subjectName} ${verb}`}
                  >
                    <span className="text-white">{entry.subjectName}</span>{" "}
                    <span className="text-white/60">{verb}</span>
                  </span>
                  <span className="shrink-0 text-[14px] leading-[20px] text-white/60 font-mono">
                    {formatDurationMs(entry.localT)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Resync button — anchors top OR bottom of the list depending
              on which way the playhead has drifted out of view. Full-
              width to accommodate the wrapped RU label "К текущему
              моменту"; hidden when the anchor is currently visible. */}
          {!autoSync && !anchorVisible && (
            <button
              type="button"
              onClick={() => setAutoSync(true)}
              className={`absolute left-0 right-0 h-[28px] flex items-center justify-center gap-1.5 bg-[#f4db50] text-[#202427] text-[12px] leading-none font-medium shadow-[0px_4px_12px_rgba(0,0,0,0.4)] hover:bg-[#f9e278] transition-colors ${
                resyncDirection === "up" ? "top-0" : "bottom-0"
              }`}
            >
              <MaskIcon
                src={
                  resyncDirection === "up"
                    ? "/icons/figma/chevron-up.svg"
                    : "/icons/figma/chevron-down.svg"
                }
                size={14}
                color="#202427"
              />
              {t("eventLog.resync")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  ariaLabel,
  iconSrc,
}: {
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
  iconSrc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`size-[28px] flex items-center justify-center rounded-[4px] transition-colors ${
        active ? "bg-[#f4db50]" : "bg-[#2e3439] hover:bg-[#3a4249]"
      }`}
    >
      {/* Active = dark icon on yellow bg (lets the meaning read at a glance
       *  alongside the brand accent). Inactive = grey so the row reads as
       *  muted/off; the colored variants only live in the list itself. */}
      <MaskIcon
        src={iconSrc}
        size={16}
        color={active ? "#202427" : "#6b7280"}
      />
    </button>
  );
}
