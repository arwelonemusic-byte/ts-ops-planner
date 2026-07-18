// Replay JSON → indexed lookup helpers + interpolation.
//
// The mod ships events ordered by `t` (ms since session start). For playback
// we want O(log n) state queries at any time t, so on load we bucket events
// per-character into time-sorted arrays and binary-search them at render time.

import { findMap, MAPS, type MapConfig } from "./maps";

/** Mod-resolved vehicle category. Mirrors the three-way split the mod ships
 *  on every `vehicle_register`:
 *    - `vehicle_unarmed`: trucks, civilian cars, ambulances, unarmed jeeps.
 *    - `vehicle_armed`: any vehicle the editor labels TRAIT_ARMED — covers
 *      Humvees with mounted guns, BTRs, tanks, attack helicopters,
 *      technicals. We bundle all "has a gun" mobiles into one bucket;
 *      tank-vs-APC distinction isn't worth a separate glyph.
 *    - `static_weapon`: tripod-mounted MGs, mortars, anything whose root
 *      entity class is Turret.
 *  Used as the discriminator for the replay viewer's marker glyph. */
export type VehicleKind = "vehicle_unarmed" | "vehicle_armed" | "static_weapon";

export type ReplayEvent =
  | { t: number; type: "player_join"; playerId: number; playerGuid: string; name: string }
  | {
      t: number;
      type: "char_register";
      charId: number;
      factionKey: string;
      isPlayerControlled: boolean;
      /** RGB int packed as 0xRRGGBB. 0 = unknown (mod couldn't resolve, or
       *  legacy replay from before factionColor shipped). Web unpacks to a
       *  CSS hex string at index time. */
      factionColor?: number;
    }
  | { t: number; type: "possess"; playerId: number; charId: number }
  | { t: number; type: "move"; charId: number; x: number; z: number; yaw: number }
  | { t: number; type: "damage_state"; charId: number; state: number }
  | { t: number; type: "char_delete"; charId: number }
  | {
      t: number;
      type: "shot";
      shooterCharId: number;
      originX: number;
      originZ: number;
      hitX: number;
      hitZ: number;
      /** Mod tags warhead-driven projectiles (frags, rockets, UGL grenades)
       *  with this flag so the renderer can layer a blast circle on top of
       *  the trajectory line. Optional because pre-flag replays predate the
       *  schema; absent → falls back to the geometric heuristic
       *  (origin == hit) used for the legacy degenerate case. */
      isExplosion?: boolean;
      /** Heavier ordnance (rockets, mortars). Renders a thicker dashed trail.
       *  Only meaningful when `isExplosion` is true. */
      isHeavy?: boolean;
    }
  | {
      t: number;
      type: "vehicle_register";
      vehicleId: number;
      factionKey: string;
      factionColor?: number;
      name: string;
      /** Mod-resolved category — drives marker glyph. Absent on replays
       *  recorded before the field shipped; legacy default is
       *  `vehicle_unarmed` (the existing pentagon). */
      kind?: VehicleKind;
    }
  | { t: number; type: "vehicle_move"; vehicleId: number; x: number; z: number; yaw: number }
  | { t: number; type: "vehicle_occupants"; vehicleId: number; charIds: number[] }
  | { t: number; type: "vehicle_destroyed"; vehicleId: number }
  | { t: number; type: "vehicle_delete"; vehicleId: number }
  | {
      t: number;
      type: "kill";
      /** RplComponent.Id of the killer character; 0 when environment/unknown. */
      killerCharId: number;
      /** PlayerId controlling the killer at kill-time; 0 if AI killer. */
      killerPlayerId: number;
      /** RplComponent.Id of the victim character. */
      victimCharId: number;
      /** PlayerId controlling the victim at kill-time; 0 if AI victim. */
      victimPlayerId: number;
      /** Same-faction-compare done mod-side. True covers player-on-player AND
       *  player-on-friendly-AI uniformly (the "killed a teammate" semantic). */
      isTeamKill: boolean;
    };

export type ReplayMeta = {
  startedAt: number;
  schemaVersion: number;
  friendlyFactionKey?: string;
  /** The mission-author-named world file basename. Renameable, NOT stable
   *  for map detection — kept only for visibility/debugging. */
  worldFileName?: string;
  /** Stable terrain identifier from a tile-supertexture resource path
   *  (e.g. "worlds/Arland/Terrain/.Data/Terrain_0_supertexture.edds"). The
   *  second segment is the stock-world directory name. Empty when the mod
   *  couldn't resolve it (rare; falls back to manual map override). */
  terrainResource?: string;
  /** Plan code stamped by the mod whenever an admin runs /syncplan during
   *  the session. Last-wins: a later /syncplan overwrites this. The web
   *  replay viewer pre-fills the plan-overlay code input with this value
   *  so a session's commander-pushed plan auto-resolves without manual
   *  paste. Empty / absent on legacy replays and on sessions where no
   *  /syncplan was ever run — viewer falls back to user-entered code in
   *  those cases. (Mod-side stamping is not yet implemented; field is
   *  reserved here for forward compatibility — see ARCHITECTURE.md.) */
  planCode?: string;
};

export type ReplayData = {
  code: string;
  world: string; // mission-author-named world file basename (legacy; prefer meta.terrainResource)
  meta: ReplayMeta;
  events: ReplayEvent[];
  created_at: string;
};

export type ReplayCharState = {
  charId: number;
  factionKey: string;
  x: number;
  z: number;
  yaw: number;
  isPlayerControlled: boolean;
  damageState: number; // 0 = alive
  controllingPlayerId: number | null;
  playerName: string | null;
  /** Marker opacity in [0, 1]. 1.0 in normal playback. Less than 1 only
   *  during the fade-out tail of the post-death linger window for
   *  player-controlled chars whose body has already been despawned
   *  (char_delete fired). The renderer applies this to the icon wrapper. */
  opacity: number;
};

/** How long a player-controlled char's marker remains visible after the
 *  engine despawns the body. Wider than Reforger's corpse cleanup window
 *  so commanders can still locate casualties on the timeline after the
 *  char_delete event evicts the live render. */
export const LINGER_MS = 5 * 60 * 1000;
/** Length of the fade-out at the end of LINGER_MS. The marker holds full
 *  opacity for LINGER_MS - LINGER_FADE_MS, then linearly fades to 0. */
export const LINGER_FADE_MS = 30 * 1000;

// Stock-terrain folder name → maps.ts key. The mod sends a tile-supertexture
// path like "worlds/Arland/Terrain/.Data/Terrain_0_supertexture.edds"; we
// parse the second segment and look it up here. Reforger DLC and mod worlds
// use BI internal codenames that don't always match the in-game label
// (Eden = Everon, Cain = Kolguyev, ChernoT = Chernarus, etc.) — keep keys
// lowercased so the lookup is case-insensitive at the match site.
//
// **Limitation**: this only works for stock/known-mod inheritance. Modded
// worlds with a non-standard folder name fall through and the user must
// pick the map manually in the replay panel.
const TERRAIN_FOLDER_TO_MAP_KEY: Record<string, string> = {
  arland: "arland",
  eden: "everon",
  cain: "kolguyev",
  chernot: "chernarus",
  zarichne: "zarichne",
  zargabad: "zargabad",
  zimnitrita: "zimnitrita",
  serhiivka: "serhiivka",
  takistan: "takistan",
  ruha: "ruha",
  anizay: "anizay",
  chernarus: "chernarus",
  faircroft: "faircroft",
  britmapproject: "faircroft", // Faircroft Islands ships under codename "BritMapProject"
  armenhof: "armenhof",
  al_hadra: "alhadra",
  seitenbuch: "seitenbuch",
  iraq: "iraq1990",
  kunar: "kunar",
};

// worldFileName → maps.ts key. Higher-precision override for missions whose
// terrain folder is too generic to key on safely. `chokehold-world` ships on
// a Zarichne reskin but names its world folder the generic "Terrain", which
// would collide with any other mod that does the same — so we match on the
// specific mission world file basename (meta.worldFileName) instead. Checked
// before the terrain-folder table in resolveReplayMapKey.
const WORLD_FILE_TO_MAP_KEY: Record<string, string> = {
  "chokehold-world": "zarichne",
};

/** Parse the terrain folder from a supertexture resource path. Returns null
 *  if the path doesn't match the expected `world(s)/<TerrainFolder>/...`
 *  shape. The prefix is case-insensitive AND accepts both `world/` and
 *  `worlds/` because mod authors don't agree on the naming:
 *    - Arland / Cain (BI vanilla):  `worlds/...`
 *    - ChernoT (mod):               `Worlds/...`
 *    - Zimnitrita (mod):            `World/...`   (singular!)
 *  When this returns null, the renderer falls back to the manual map
 *  selector in the replay panel. */
export function parseTerrainFolder(terrainResource: string): string | null {
  if (!terrainResource) return null;
  const stripped = terrainResource.replace(/^\{[0-9A-Fa-f]+\}/, "");
  const m = stripped.match(/^worlds?\/([^/]+)\//i);
  return m ? m[1] : null;
}

/** Resolve a replay's auto-detected map key, or null if the mod-side
 *  terrainResource didn't match a known stock world. */
export function resolveReplayMapKey(replay: ReplayData): string | null {
  // Highest precision: exact mission world-file match (covers worlds whose
  // terrain folder name is too generic to key on — e.g. chokehold-world).
  const worldFile = (replay.meta?.worldFileName ?? "").toLowerCase();
  if (worldFile) {
    const wHit = WORLD_FILE_TO_MAP_KEY[worldFile];
    if (wHit) return wHit;
  }
  const tr = replay.meta?.terrainResource ?? "";
  const folder = parseTerrainFolder(tr);
  if (folder) {
    const hit = TERRAIN_FOLDER_TO_MAP_KEY[folder.toLowerCase()];
    if (hit) return hit;
  }
  // Legacy fallback: the older mod versions sent only the world file basename
  // in the top-level `world` field. If it happens to match a registered map
  // key (lowercased), use that.
  const legacy = (replay.world || "").toLowerCase();
  if (MAPS.find((m) => m.key === legacy)) return legacy;
  return null;
}

export function resolveReplayMap(replay: ReplayData): MapConfig {
  const key = resolveReplayMapKey(replay);
  return findMap(key);
}

export type ReplayIndex = {
  data: ReplayData;
  /** Per-char arrays of move events, sorted by t ascending (raw, mod-side t). */
  movesByChar: Map<number, Extract<ReplayEvent, { type: "move" }>[]>;
  /** Per-char arrays of damage_state events, sorted by t ascending. */
  damageByChar: Map<number, Extract<ReplayEvent, { type: "damage_state" }>[]>;
  /** Per-char registration (last char_register wins). */
  registrations: Map<
    number,
    {
      factionKey: string;
      isPlayerControlled: boolean;
      t: number;
      /** Faction display color as a CSS hex string (`#rrggbb`), or null if
       *  the mod didn't resolve one. When present, this is the authoritative
       *  triangle/tracer color. When null, callers fall back to the
       *  blue/red identity heuristic. */
      factionColorHex: string | null;
    }
  >;
  /** Per-char deletion time, undefined if never deleted. */
  deletions: Map<number, number>;
  /** All possess events sorted by t. */
  possesses: Extract<ReplayEvent, { type: "possess" }>[];
  /** charId → playerId of the most recent player to possess that char.
   *  Survives the death-time spectator transfer that clears the live
   *  possess mapping, so lingering dead-player markers can still resolve
   *  a name for the hover tooltip. */
  lastPossessorByChar: Map<number, number>;
  /** All shot events sorted by t. Player and AI shooters are mixed. */
  shots: Extract<ReplayEvent, { type: "shot" }>[];
  /** Player names by playerId (last-seen wins). */
  playerNames: Map<number, string>;
  /** charIds that were ever possessed by a player with a name. The
   *  identity-based friend/foe heuristic colors these blue regardless of
   *  faction. Computed once at index time. */
  friendlyCharIds: Set<number>;
  /** Factions that any friendly char belongs to. Friendly AI (squadmates,
   *  bots on the player's side) get blue when their faction lands here. */
  friendlyFactions: Set<string>;
  /** Per-vehicle move event arrays, sorted by t. Same shape as movesByChar. */
  vehicleMovesById: Map<number, Extract<ReplayEvent, { type: "vehicle_move" }>[]>;
  /** Per-vehicle occupant snapshots, sorted by t. Each entry is a complete
   *  occupant set (mod emits diffs only on change so the size is bounded). */
  vehicleOccupantsById: Map<number, Extract<ReplayEvent, { type: "vehicle_occupants" }>[]>;
  /** Per-vehicle registration (last char_register-style wins). */
  vehicleRegistrations: Map<
    number,
    {
      factionKey: string;
      factionColorHex: string | null;
      name: string;
      kind: VehicleKind;
      t: number;
    }
  >;
  /** Per-vehicle destruction time, undefined if still alive. */
  vehicleDestructions: Map<number, number>;
  /** Per-vehicle deletion time. */
  vehicleDeletions: Map<number, number>;
  /** All kill events sorted by t. Mod emits one per terminal character death
   *  with killer attribution + team-kill flag. AI-victim kills are kept (not
   *  surfaced in the UI) so future stats queries can aggregate. */
  kills: Extract<ReplayEvent, { type: "kill" }>[];
  /** Latest kill event per victimCharId. A char can only terminally die
   *  once per spawn, so the map is effectively 1:1; if duplicates ever
   *  arrive (engine quirk / re-fire), last-wins. */
  killByVictimCharId: Map<number, Extract<ReplayEvent, { type: "kill" }>>;
  /** First event's t (mod-side). Subtract this from raw t to get a 0-anchored
   *  display time. The mod's `t` is World.GetWorldTime() since BeginSession,
   *  not since the first emitted event — and there can be a long gap between
   *  scenario start and the first character spawn (respawn menu, loadout
   *  selection, etc.), which would otherwise make the timeline mostly empty. */
  firstT: number;
  /** Display duration in ms — `lastT - firstT`, clamped to >= 0. */
  durationMs: number;
  /** Distinct playerIds that ever joined. */
  playerCount: number;
};

export function indexReplay(data: ReplayData): ReplayIndex {
  const movesByChar = new Map<number, Extract<ReplayEvent, { type: "move" }>[]>();
  const damageByChar = new Map<number, Extract<ReplayEvent, { type: "damage_state" }>[]>();
  const registrations = new Map<
    number,
    {
      factionKey: string;
      isPlayerControlled: boolean;
      t: number;
      factionColorHex: string | null;
    }
  >();
  const deletions = new Map<number, number>();
  const possesses: Extract<ReplayEvent, { type: "possess" }>[] = [];
  const shots: Extract<ReplayEvent, { type: "shot" }>[] = [];
  const playerNames = new Map<number, string>();
  const playerIds = new Set<number>();
  const vehicleMovesById = new Map<number, Extract<ReplayEvent, { type: "vehicle_move" }>[]>();
  const vehicleOccupantsById = new Map<number, Extract<ReplayEvent, { type: "vehicle_occupants" }>[]>();
  const vehicleRegistrations = new Map<
    number,
    {
      factionKey: string;
      factionColorHex: string | null;
      name: string;
      kind: VehicleKind;
      t: number;
    }
  >();
  const vehicleDestructions = new Map<number, number>();
  const vehicleDeletions = new Map<number, number>();
  const kills: Extract<ReplayEvent, { type: "kill" }>[] = [];
  const killByVictimCharId = new Map<number, Extract<ReplayEvent, { type: "kill" }>>();

  for (const ev of data.events) {
    switch (ev.type) {
      case "move": {
        const arr = movesByChar.get(ev.charId);
        if (arr) arr.push(ev);
        else movesByChar.set(ev.charId, [ev]);
        break;
      }
      case "damage_state": {
        const arr = damageByChar.get(ev.charId);
        if (arr) arr.push(ev);
        else damageByChar.set(ev.charId, [ev]);
        break;
      }
      case "char_register": {
        // Last-wins. The mod may emit char_register twice for player chars:
        // once from EOnInit auto-register (faction may be a prefab default
        // before slot/loadout assignment) and once from PlayerController
        // possess (faction is authoritative at that point). Last wins so
        // the possess-time event corrects the early guess. We keep the
        // ORIGINAL `t` (when the char first appeared in the replay) so the
        // registration anchors to the spawn moment, not the possess moment.
        const existing = registrations.get(ev.charId);
        const fc = ev.factionColor ?? 0;
        const factionColorHex = fc > 0 ? `#${fc.toString(16).padStart(6, "0")}` : null;
        registrations.set(ev.charId, {
          factionKey: ev.factionKey,
          isPlayerControlled: ev.isPlayerControlled,
          t: existing ? existing.t : ev.t,
          factionColorHex,
        });
        break;
      }
      case "char_delete":
        deletions.set(ev.charId, ev.t);
        break;
      case "possess":
        possesses.push(ev);
        break;
      case "shot":
        shots.push(ev);
        break;
      case "player_join":
        playerNames.set(ev.playerId, ev.name);
        playerIds.add(ev.playerId);
        break;
      case "vehicle_move": {
        const arr = vehicleMovesById.get(ev.vehicleId);
        if (arr) arr.push(ev);
        else vehicleMovesById.set(ev.vehicleId, [ev]);
        break;
      }
      case "vehicle_occupants": {
        const arr = vehicleOccupantsById.get(ev.vehicleId);
        if (arr) arr.push(ev);
        else vehicleOccupantsById.set(ev.vehicleId, [ev]);
        break;
      }
      case "vehicle_register": {
        // Same last-wins pattern as char_register; keep original `t` so the
        // registration anchors to the spawn moment.
        const existing = vehicleRegistrations.get(ev.vehicleId);
        const fc = ev.factionColor ?? 0;
        const factionColorHex = fc > 0 ? `#${fc.toString(16).padStart(6, "0")}` : null;
        vehicleRegistrations.set(ev.vehicleId, {
          factionKey: ev.factionKey,
          factionColorHex,
          name: ev.name,
          kind: ev.kind ?? "vehicle_unarmed",
          t: existing ? existing.t : ev.t,
        });
        break;
      }
      case "vehicle_destroyed":
        vehicleDestructions.set(ev.vehicleId, ev.t);
        break;
      case "vehicle_delete":
        vehicleDeletions.set(ev.vehicleId, ev.t);
        break;
      case "kill":
        kills.push(ev);
        killByVictimCharId.set(ev.victimCharId, ev);
        break;
    }
  }

  // Events arrive ordered by mod-side flush, but defensively sort each per-char
  // time series — flush boundaries can occasionally land out-of-order if the
  // server clock ticked while a previous batch was inflight.
  for (const arr of movesByChar.values()) arr.sort((a, b) => a.t - b.t);
  for (const arr of damageByChar.values()) arr.sort((a, b) => a.t - b.t);
  for (const arr of vehicleMovesById.values()) arr.sort((a, b) => a.t - b.t);
  for (const arr of vehicleOccupantsById.values()) arr.sort((a, b) => a.t - b.t);
  possesses.sort((a, b) => a.t - b.t);
  shots.sort((a, b) => a.t - b.t);
  kills.sort((a, b) => a.t - b.t);

  // Last player to possess each char. Walked over the already-sorted
  // possess list so the final entry wins. Skips charId === 0 (the release
  // sentinel) so we keep the prior driver, not the "nobody" transfer.
  const lastPossessorByChar = new Map<number, number>();
  for (const ev of possesses) {
    if (ev.charId !== 0) lastPossessorByChar.set(ev.charId, ev.playerId);
  }

  const firstT = data.events.length > 0 ? data.events[0].t : 0;
  const lastT = data.events.length > 0 ? data.events[data.events.length - 1].t : 0;
  const durationMs = Math.max(0, lastT - firstT);

  // Retroactive orphan-AI cleanup. Reforger's AI despawn path doesn't
  // reliably invoke the script-side ~SCR_ChimeraCharacter dtor, so older
  // replays (and any replay recorded before the mod-side GC ships) leak
  // char_register entries that never receive a matching char_delete —
  // every despawned AI is stuck as a frozen triangle at its last-known
  // position, piling up into "swarms" by mid-session (e.g. JXPDD5 had
  // 320 of 379 chars in this state).
  //
  // Heuristic: a char with no char_delete whose last move event is more
  // than ORPHAN_GAP_MS before the session's end has almost certainly
  // been despawned by the engine. The threshold (60s) is generous —
  // well outside any plausible AI poll interval (max 3s in long-op
  // config) — so we don't accidentally evict a stationary live AI
  // suppressed by Layer-1 dedup. Synthetic delete lands at lastMove+1
  // so the renderer's "deleted at or after t" gate flips immediately.
  const ORPHAN_GAP_MS = 60_000;
  for (const [charId] of registrations) {
    if (deletions.has(charId)) continue;
    const moves = movesByChar.get(charId);
    if (!moves || moves.length === 0) continue;
    const lastMoveT = moves[moves.length - 1].t;
    if (lastT - lastMoveT > ORPHAN_GAP_MS) {
      deletions.set(charId, lastMoveT + 1);
    }
  }

  // Identity-based friend resolution. Walk possess events: any charId paired
  // with a known player name is "friendly". Their faction (from the
  // authoritative possess-time char_register, thanks to last-wins) becomes a
  // friendly faction — so squadmate AI inherit blue without needing
  // friendlyFactionKey config. Heuristic breaks only in PvP where players
  // exist on both sides; users with that scenario should set
  // friendlyFactionKey explicitly.
  const friendlyCharIds = new Set<number>();
  for (const ev of possesses) {
    if (ev.charId !== 0 && playerNames.has(ev.playerId)) {
      friendlyCharIds.add(ev.charId);
    }
  }
  const friendlyFactions = new Set<string>();
  for (const charId of friendlyCharIds) {
    const reg = registrations.get(charId);
    if (reg && reg.factionKey) friendlyFactions.add(reg.factionKey);
  }

  return {
    data,
    movesByChar,
    damageByChar,
    registrations,
    deletions,
    possesses,
    lastPossessorByChar,
    shots,
    playerNames,
    friendlyCharIds,
    friendlyFactions,
    vehicleMovesById,
    vehicleOccupantsById,
    vehicleRegistrations,
    vehicleDestructions,
    vehicleDeletions,
    kills,
    killByVictimCharId,
    firstT,
    durationMs,
    playerCount: playerIds.size,
  };
}

/** Linear position + shortest-arc yaw interpolation for a char's move list. */
function interpolateChar(
  moves: Extract<ReplayEvent, { type: "move" }>[],
  t: number,
): { x: number; z: number; yaw: number } {
  if (t <= moves[0].t) {
    const first = moves[0];
    return { x: first.x, z: first.z, yaw: first.yaw };
  }
  const last = moves[moves.length - 1];
  if (t >= last.t) return { x: last.x, z: last.z, yaw: last.yaw };

  // Binary search for the last move with t <= target.
  let lo = 0;
  let hi = moves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (moves[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = moves[lo];
  const b = moves[lo + 1];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  const x = a.x + (b.x - a.x) * f;
  const z = a.z + (b.z - a.z) * f;
  let dy = b.yaw - a.yaw;
  while (dy > 180) dy -= 360;
  while (dy < -180) dy += 360;
  const yaw = (((a.yaw + dy * f) % 360) + 360) % 360;
  return { x, z, yaw };
}

/** Damage state for a char at time t. Latest-wins on the per-char
 *  damage_state stream. The mod's life-state hook now emits both DESTROYED
 *  (incap or dead) and UNDAMAGED (revived) so a sequence like
 *  ALIVE→INCAP→ALIVE→DEAD renders as grey→colour→grey naturally. The old
 *  lock-on-DESTROYED behavior left medic-revived players permanently grey
 *  even after they got back up. */
function damageStateAt(
  damages: Extract<ReplayEvent, { type: "damage_state" }>[] | undefined,
  t: number,
): number {
  if (!damages || damages.length === 0) return 0;
  if (damages[0].t > t) return 0;
  let latest = 0;
  for (const e of damages) {
    if (e.t > t) break;
    latest = e.state;
  }
  return latest;
}

/** Time of the latest DESTROYED transition at or before tCap with no later
 *  UNDAMAGED transition before tCap. Returns null if the char never died
 *  by tCap, or if the most recent state transition was a revive (the player
 *  recovered from incap and never died again). Used to anchor the post-death
 *  linger window for player-controlled chars whose body has been despawned —
 *  we want the marker to vanish at deathT + LINGER_MS, not deletedAt + LINGER_MS,
 *  since the body can despawn anywhere from seconds to minutes after death. */
function finalDeathTimeBefore(
  damages: Extract<ReplayEvent, { type: "damage_state" }>[] | undefined,
  tCap: number,
): number | null {
  if (!damages || damages.length === 0) return null;
  let deathT: number | null = null;
  for (const e of damages) {
    if (e.t > tCap) break;
    if (e.state === DAMAGE_DESTROYED) deathT = e.t;
    else if (e.state === 0) deathT = null;
  }
  return deathT;
}

/** Player→character mapping at time t (which player controls which char). */
function possessStateAt(
  possesses: Extract<ReplayEvent, { type: "possess" }>[],
  t: number,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const ev of possesses) {
    if (ev.t > t) break;
    if (ev.charId === 0) map.delete(ev.playerId);
    else map.set(ev.playerId, ev.charId);
  }
  return map;
}

export type ReplayVehicleState = {
  vehicleId: number;
  x: number;
  z: number;
  yaw: number;
  /** Display name (e.g. "M923 5T", "UH-1H"). May be empty. */
  name: string;
  /** Faction color hex from registration, or null when unset. */
  factionColorHex: string | null;
  /** Default-affiliated faction key — useful when occupied by a single
   *  faction and we want to fall back if registration color is missing. */
  factionKey: string;
  /** Mod-resolved category. Drives the marker glyph in the renderer. */
  kind: VehicleKind;
  /** charIds currently inside the vehicle (per the latest occupants
   *  snapshot at or before t). Empty when no one is in. */
  occupants: number[];
  /** True after the vehicle's destroyed event has fired by time t. */
  destroyed: boolean;
};

/** Vehicle position at time t — same binary-search-and-interpolate pattern
 *  as character moves. Yaw uses shortest-arc interpolation. */
function interpolateVehicle(
  moves: Extract<ReplayEvent, { type: "vehicle_move" }>[],
  t: number,
): { x: number; z: number; yaw: number } {
  if (t <= moves[0].t) {
    const first = moves[0];
    return { x: first.x, z: first.z, yaw: first.yaw };
  }
  const last = moves[moves.length - 1];
  if (t >= last.t) return { x: last.x, z: last.z, yaw: last.yaw };

  let lo = 0;
  let hi = moves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (moves[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = moves[lo];
  const b = moves[lo + 1];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  const x = a.x + (b.x - a.x) * f;
  const z = a.z + (b.z - a.z) * f;
  let dy = b.yaw - a.yaw;
  while (dy > 180) dy -= 360;
  while (dy < -180) dy += 360;
  const yaw = (((a.yaw + dy * f) % 360) + 360) % 360;
  return { x, z, yaw };
}

/** Latest occupant snapshot at or before t. Returns [] when no snapshot
 *  has fired yet. */
function occupantsAt(
  snapshots: Extract<ReplayEvent, { type: "vehicle_occupants" }>[] | undefined,
  t: number,
): number[] {
  if (!snapshots || snapshots.length === 0) return [];
  if (snapshots[0].t > t) return [];
  // Linear scan — snapshot count per vehicle is small (only emitted on change).
  let latest = snapshots[0].charIds;
  for (const s of snapshots) {
    if (s.t > t) break;
    latest = s.charIds;
  }
  return latest;
}

/** Vehicle states active at time t. */
export function getVehicleStateAt(idx: ReplayIndex, t: number): ReplayVehicleState[] {
  const out: ReplayVehicleState[] = [];
  for (const [vehicleId, reg] of idx.vehicleRegistrations) {
    if (reg.t > t) continue;
    const deletedAt = idx.vehicleDeletions.get(vehicleId);
    if (deletedAt !== undefined && deletedAt <= t) continue;

    const moves = idx.vehicleMovesById.get(vehicleId);
    if (!moves || moves.length === 0) continue;
    if (moves[0].t > t) continue;

    const pos = interpolateVehicle(moves, t);
    const occupants = occupantsAt(idx.vehicleOccupantsById.get(vehicleId), t);
    const destroyedAt = idx.vehicleDestructions.get(vehicleId);
    const destroyed = destroyedAt !== undefined && destroyedAt <= t;

    out.push({
      vehicleId,
      x: pos.x,
      z: pos.z,
      yaw: pos.yaw,
      name: reg.name,
      factionColorHex: reg.factionColorHex,
      factionKey: reg.factionKey,
      kind: reg.kind,
      occupants,
      destroyed,
    });
  }
  return out;
}

/** Hex used for empty / unidentified vehicle markers. Yellow per the Figma
 *  spec — "unknown" semantic, distinct from friendly/enemy. */
export const HEX_VEHICLE_EMPTY = "#f4db50";

/** Vehicle color follows three states:
 *
 *   1. Destroyed → grey.
 *   2. Occupied → faction color of the occupants (resolved via the first
 *      registered occupant's char registration; tie-breaking on uniformity).
 *      Falls back to the vehicle's own registered faction color when
 *      occupants don't have one (rare).
 *   3. Empty → yellow (HEX_VEHICLE_EMPTY).
 *
 *  When occupants are mixed faction (capture mid-progress, hostage scenarios)
 *  we colour by majority; ties pick the first occupant's faction. */
export function resolveVehicleHex(
  state: ReplayVehicleState,
  idx: ReplayIndex,
  t: number,
): string {
  if (state.destroyed) return HEX_DESTROYED;
  if (state.occupants.length === 0) {
    // Empty: yellow regardless of the vehicle's prefab faction. Per Figma.
    return HEX_VEHICLE_EMPTY;
  }
  // Occupied: tally factions among LIVE occupants. Dead bodies don't
  // contribute to the color — a vehicle with only a corpse inside reads as
  // yellow/empty, matching the "color = live combatants" rule that chars
  // already follow.
  const counts = new Map<string, number>();
  let firstHex: string | null = null;
  let hasLiveOccupant = false;
  for (const charId of state.occupants) {
    const dmg = damageStateAt(idx.damageByChar.get(charId), t);
    if (dmg >= DAMAGE_DESTROYED) continue;
    hasLiveOccupant = true;
    const reg = idx.registrations.get(charId);
    if (!reg || !reg.factionColorHex) continue;
    counts.set(reg.factionColorHex, (counts.get(reg.factionColorHex) ?? 0) + 1);
    if (firstHex === null) firstHex = reg.factionColorHex;
  }
  if (!hasLiveOccupant) {
    // Every occupant is dead — vehicle reads as empty (yellow) regardless of
    // its prefab faction. Matches the "color = live combatants" semantics.
    return HEX_VEHICLE_EMPTY;
  }
  if (counts.size === 0) {
    // Live occupants exist but none registered with a faction color (legacy
    // replay or unregistered AI). Fall back to vehicle's prefab faction.
    return state.factionColorHex ?? HEX_VEHICLE_EMPTY;
  }
  // Majority vote, ties broken by first-occupant order.
  let bestHex = firstHex!;
  let bestCount = counts.get(bestHex) ?? 0;
  for (const [hex, n] of counts) {
    if (n > bestCount) {
      bestHex = hex;
      bestCount = n;
    }
  }
  return bestHex;
}

/** Count of named-player occupants in a vehicle at time t. Drives the
 *  number badge. AI occupants don't count — the badge is specifically a
 *  "how many human players are in this thing" indicator. */
export function namedPlayerOccupantCount(
  state: ReplayVehicleState,
  idx: ReplayIndex,
  t: number,
): number {
  if (state.occupants.length === 0) return 0;
  // Resolve player→char mapping at time t, then check which of our occupants
  // are currently being possessed by a named player.
  const possess = new Map<number, number>();
  for (const ev of idx.possesses) {
    if (ev.t > t) break;
    if (ev.charId === 0) possess.delete(ev.playerId);
    else possess.set(ev.playerId, ev.charId);
  }
  const charsToNamedPlayers = new Set<number>();
  for (const [pid, cid] of possess) {
    if (idx.playerNames.has(pid)) charsToNamedPlayers.add(cid);
  }
  let count = 0;
  for (const charId of state.occupants) {
    if (charsToNamedPlayers.has(charId)) count++;
  }
  return count;
}

/** Names of the named-player occupants riding in a vehicle at time t.
 *  Resolves the player→char mapping the same way as namedPlayerOccupantCount,
 *  then keeps only occupants whose controlling player has a known display
 *  name. AI occupants are skipped (no playerName to render). Order follows
 *  state.occupants — typically driver → gunner → passengers, but the mod
 *  doesn't guarantee seat-role ordering, so callers shouldn't depend on it. */
export function namedPlayerOccupantNames(
  state: ReplayVehicleState,
  idx: ReplayIndex,
  t: number,
): { name: string; dead: boolean }[] {
  if (state.occupants.length === 0) return [];
  // Live possess map at time t — same walk as elsewhere.
  const possess = new Map<number, number>();
  for (const ev of idx.possesses) {
    if (ev.t > t) break;
    if (ev.charId === 0) possess.delete(ev.playerId);
    else possess.set(ev.playerId, ev.charId);
  }
  const liveCharToPid = new Map<number, number>();
  for (const [pid, cid] of possess) liveCharToPid.set(cid, pid);

  const damages = idx.damageByChar;
  const out: { name: string; dead: boolean }[] = [];
  for (const charId of state.occupants) {
    const dmg = damageStateAt(damages.get(charId), t);
    const dead = dmg >= DAMAGE_DESTROYED;
    // Dead chars get cleared from live possess by the spectator transfer, so
    // fall back to lastPossessorByChar — same pattern as getStateAt's
    // dead-player name resolution.
    let pid = liveCharToPid.get(charId);
    if (pid === undefined && dead) pid = idx.lastPossessorByChar.get(charId);
    if (pid === undefined) continue;
    const name = idx.playerNames.get(pid);
    if (!name) continue;
    out.push({ name, dead });
  }
  return out;
}

/** Set of charIds currently inside any non-destroyed vehicle at time t.
 *  Used to suppress char triangles for chars riding inside (otherwise they'd
 *  pile up at the vehicle's location). */
export function charsInVehiclesAt(idx: ReplayIndex, t: number): Set<number> {
  const out = new Set<number>();
  for (const [vehicleId, snapshots] of idx.vehicleOccupantsById) {
    const destroyedAt = idx.vehicleDestructions.get(vehicleId);
    if (destroyedAt !== undefined && destroyedAt <= t) continue;
    const deletedAt = idx.vehicleDeletions.get(vehicleId);
    if (deletedAt !== undefined && deletedAt <= t) continue;
    const occ = occupantsAt(snapshots, t);
    for (const charId of occ) out.add(charId);
  }
  return out;
}

/** Character states active at the given playback time. */
export function getStateAt(idx: ReplayIndex, t: number): ReplayCharState[] {
  const out: ReplayCharState[] = [];
  const possessNow = possessStateAt(idx.possesses, t);
  const charToPlayer = new Map<number, number>();
  for (const [pid, cid] of possessNow) charToPlayer.set(cid, pid);

  for (const [charId, reg] of idx.registrations) {
    if (reg.t > t) continue;

    let opacity = 1;
    const deletedAt = idx.deletions.get(charId);
    if (deletedAt !== undefined && deletedAt <= t) {
      // Default behavior: char is gone, skip. Exception: keep player-
      // controlled casualties on the map for LINGER_MS after their final
      // death so a commander scrubbing the timeline can still see where
      // each KIA fell after Reforger's fast corpse cleanup evicts the
      // body. AI chars are excluded — long ops produce hundreds of AI
      // deaths and the resulting marker pile-up would defeat the purpose.
      if (!reg.isPlayerControlled) continue;
      const deathT = finalDeathTimeBefore(idx.damageByChar.get(charId), deletedAt);
      if (deathT === null) continue;
      const sinceDeath = t - deathT;
      if (sinceDeath > LINGER_MS) continue;
      const fadeStart = LINGER_MS - LINGER_FADE_MS;
      if (sinceDeath > fadeStart) {
        opacity = Math.max(0, 1 - (sinceDeath - fadeStart) / LINGER_FADE_MS);
      }
    }

    const moves = idx.movesByChar.get(charId);
    if (!moves || moves.length === 0) continue;
    if (moves[0].t > t) continue;

    // interpolateChar clamps to the last entry when t >= last move's t,
    // so lingering chars naturally pin to where the corpse last polled
    // before char_delete — no special-case needed here.
    const pos = interpolateChar(moves, t);
    const dmg = damageStateAt(idx.damageByChar.get(charId), t);
    // For dead chars (incap or destroyed) the live possess mapping has
    // already been cleared by the spectator/respawn transfer, so the
    // normal lookup returns null. Fall back to the last-known possessor
    // so the hover tooltip can still identify the casualty by player
    // name. Live (alive) chars always go through the authoritative
    // current-possess path.
    const isOutOfAction = dmg >= DAMAGE_INTERMEDIARY;
    const pid =
      charToPlayer.get(charId) ??
      (isOutOfAction ? (idx.lastPossessorByChar.get(charId) ?? null) : null);
    const name = pid !== null ? (idx.playerNames.get(pid) ?? null) : null;

    out.push({
      charId,
      factionKey: reg.factionKey,
      x: pos.x,
      z: pos.z,
      yaw: pos.yaw,
      isPlayerControlled: reg.isPlayerControlled,
      damageState: dmg,
      controllingPlayerId: pid,
      playerName: name,
      opacity,
    });
  }
  return out;
}

/** Default fade window for tracer/explosion rendering (ms). A shot at time
 *  s with fadeMs window is visible for t in [s, s + fadeMs] with opacity
 *  linearly decaying from 1 → 0 across the interval. */
export const SHOT_FADE_MS = 1500;

/** Renderable shot with current opacity, derived from playback time. */
export type ShotRenderable = {
  /** Mod-side timestamp; unique per shot, stable across frames — use as
   *  React key. */
  t: number;
  shooterCharId: number;
  originX: number;
  originZ: number;
  hitX: number;
  hitZ: number;
  /** [0, 1] — 1.0 at the moment of the shot, 0 at the end of the fade. */
  opacity: number;
  /** True for explosive projectiles (frags, rockets, UGL). Renderer draws a
   *  blast circle at the hit; combine with `hasLine` to also draw a dashed
   *  trajectory line from the origin. */
  isExplosion: boolean;
  /** True when origin and hit differ enough that drawing a line is meaningful.
   *  False for the legacy "instigator missing" degenerate case (origin == hit)
   *  where a zero-length line would be a visual artefact. */
  hasLine: boolean;
  /** Heavy ordnance flag (rockets, mortars). Renderer uses a thicker dashed
   *  trail. Only meaningful when isExplosion is also true. */
  isHeavy: boolean;
  /** CSS hex color resolved from the shooter's registration. Faction color
   *  when the mod sent one; otherwise blue/red via the identity heuristic.
   *  Destroyed-grey doesn't apply to shots — they're momentary events
   *  emitted at the time of impact. */
  color: string;
};

/** Shots active at playback time t given the configured fade window.
 *  Binary-searches the lower bound (first shot whose visibility window
 *  overlaps t) so the per-frame cost stays at O(visible-shots). Resolves
 *  shooter faction → friend/foe color via the registration index, so the
 *  renderer doesn't need to know about teamColorFor. */
export function activeShotsAt(
  idx: ReplayIndex,
  t: number,
  friendlyFactionKey: string | undefined,
  fadeMs: number = SHOT_FADE_MS,
): ShotRenderable[] {
  const shots = idx.shots;
  if (shots.length === 0) return [];

  // First index with shot.t >= t - fadeMs.
  const minT = t - fadeMs;
  let lo = 0;
  let hi = shots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (shots[mid].t < minT) lo = mid + 1;
    else hi = mid;
  }

  const out: ShotRenderable[] = [];
  for (let i = lo; i < shots.length; i++) {
    const s = shots[i];
    if (s.t > t) break; // Future shots haven't fired yet.
    const age = t - s.t;
    const opacity = Math.max(0, 1 - age / fadeMs);
    if (opacity <= 0) continue;
    const dx = s.hitX - s.originX;
    const dz = s.hitZ - s.originZ;
    // `collapsed` = origin and hit within ~1m² of each other. Used as the
    // legacy isExplosion signal for replays predating the explicit field.
    // `hasLine` = the trajectory line is meaningful — false for degenerate
    // cases where a line would render as a zero-length visual artefact.
    const collapsed = dx * dx + dz * dz < 1;
    const isExplosion = s.isExplosion ?? collapsed;
    const hasLine = !collapsed;
    const isHeavy = s.isHeavy ?? false;
    const color = resolveCharHex(s.shooterCharId, idx, friendlyFactionKey, false);

    out.push({
      t: s.t,
      shooterCharId: s.shooterCharId,
      originX: s.originX,
      originZ: s.originZ,
      hitX: s.hitX,
      hitZ: s.hitZ,
      opacity,
      isExplosion,
      hasLine,
      isHeavy,
      color,
    });
  }
  return out;
}

/** Resolve friend/foe color from a charId + its faction. Two-tier:
 *
 *   1. If `friendlyFactionKey` is explicitly configured (mod $profile config),
 *      compare against it. Authoritative for PvP where the heuristic below
 *      is unreliable.
 *   2. Otherwise use the identity heuristic: any char ever possessed by a
 *      player → blue; any char whose faction matches a friendly faction
 *      (i.e. a faction a player char belongs to) → blue; everything else
 *      → red. Self-bootstraps without config and handles AI squadmates.
 *
 *  Unknown charIds with empty factionKey resolve to red — safer default
 *  for an unidentified shooter. */
export function resolveTeamColor(
  charId: number,
  factionKey: string,
  idx: ReplayIndex,
  friendlyFactionKey: string | undefined,
): "blue" | "red" {
  if (friendlyFactionKey && friendlyFactionKey !== "") {
    return factionKey === friendlyFactionKey ? "blue" : "red";
  }
  if (idx.friendlyCharIds.has(charId)) return "blue";
  if (factionKey && idx.friendlyFactions.has(factionKey)) return "blue";
  return "red";
}

/** Friend/foe color for a live ReplayCharState. Thin wrapper over
 *  resolveTeamColor that pulls charId/factionKey out of the state. */
export function teamColorFor(
  state: ReplayCharState,
  idx: ReplayIndex,
  friendlyFactionKey: string | undefined,
): "blue" | "red" {
  return resolveTeamColor(state.charId, state.factionKey, idx, friendlyFactionKey);
}

/** Hex constants for the legacy blue/red fallback when faction color isn't
 *  available. Match the friendly/enemy hexes the renderer used pre-faction-
 *  color so old replays look identical. */
export const HEX_FRIENDLY = "#3b82f6";
export const HEX_ENEMY = "#ef4444";
export const HEX_DESTROYED = "#9ca3af";

/** Render hex for a char or shot-shooter. Three-tier resolution:
 *
 *   1. Destroyed → grey (the only state that overrides faction color).
 *   2. Faction color present in registration → use it directly. This is
 *      the option-1 path and the default for any replay recorded after
 *      factionColor shipped on the mod.
 *   3. Otherwise fall back to identity-based blue/red, optionally honoring
 *      an explicit friendlyFactionKey override for PvP scenarios where
 *      identity heuristic is ambiguous.
 */
export function resolveCharHex(
  charId: number,
  idx: ReplayIndex,
  friendlyFactionKey: string | undefined,
  isDestroyed: boolean,
): string {
  if (isDestroyed) return HEX_DESTROYED;
  const reg = idx.registrations.get(charId);
  if (reg?.factionColorHex) return reg.factionColorHex;
  const factionKey = reg?.factionKey ?? "";
  const team = resolveTeamColor(charId, factionKey, idx, friendlyFactionKey);
  return team === "blue" ? HEX_FRIENDLY : HEX_ENEMY;
}

/** Reforger's EDamageState enum:
 *    UNDAMAGED=0, INTERMEDIARY=1, DESTROYED=2, STATE1=3, STATE2=4, STATE3=5
 *  The replay mod maps ECharacterLifeState onto this enum at emit time:
 *    ALIVE          → UNDAMAGED    (0)
 *    INCAPACITATED  → INTERMEDIARY (1)  — "down", recoverable
 *    DEAD           → DESTROYED    (2)  — terminal
 *  Legacy replays (pre-split) only carry 0 / 2 — every state=2 there could
 *  be either a down or a death (the mod collapsed them). New replays
 *  distinguish; the event log uses both constants to render "down" vs
 *  "killed" entries. The renderer uses DAMAGE_INTERMEDIARY as the
 *  greys-the-marker threshold so both incap and dead show as grey. */
export const DAMAGE_INTERMEDIARY = 1;
export const DAMAGE_DESTROYED = 2;

/** Metadata-only summary for a replay, used by the recent-list dropdown.
 *  Mirrors the GET /api/replays?recent=N row shape. `meta.terrainResource`
 *  is what drives the auto-detected map name; the renderer can call
 *  `resolveReplayMapKey({world, meta} as ReplayData)` on this to get a
 *  display label even before the full replay is loaded. */
export type ReplaySummary = {
  code: string;
  world: string;
  meta: ReplayMeta;
  created_at: string;
};

export async function listRecentReplays(limit = 10): Promise<ReplaySummary[]> {
  const res = await fetch(`/api/replays?recent=${encodeURIComponent(String(limit))}`);
  if (!res.ok) throw new Error(`list_failed:${res.status}`);
  const body = (await res.json()) as { replays: ReplaySummary[] };
  return body.replays;
}

/** Per-chunk fetch size. Each event is ~95 bytes, so 20k events ≈ 2 MB —
 *  comfortably under Vercel's 4.5 MB serverless body cap. Smaller chunks
 *  mean more round-trips; larger means closer to the cap. */
const CHUNK_LIMIT = 20000;
/** Max parallel chunk fetches. Browsers cap concurrent connections per
 *  origin around 6, so going much higher than that wastes connections.
 *  HTTP/2 multiplexes but we still want to be polite. */
const PARALLEL_FETCHES = 4;

/** Progress callback fired during chunked load. `loaded` and `total` are
 *  event counts (not bytes). `total` is unknown until the first chunk
 *  returns, in which case the callback fires once with `total = -1` to
 *  signal "started" — UI can show an indeterminate spinner. */
export type LoadProgress = (loaded: number, total: number) => void;

/** Hard-trim dead air at the start of a replay. The recorder begins writing
 *  the moment the server boots, which means a session typically has 10-20
 *  minutes of empty-server activity (AI registers, first idle moves) before
 *  any human appears on the map. We define T0 as the first `char_register`
 *  event with `isPlayerControlled === true` — i.e., the moment a human spawns
 *  into a character — and drop everything before it. (Trying `player_join`
 *  instead leaves visible dead air between connection and character spawn,
 *  typically 10-30 seconds of slot picking + loadout selection.)
 *
 *  Char_register and vehicle_register events for entities that are still
 *  alive at T0 are kept but rebased to `t = t0`, so the indexer's friend/foe
 *  heuristic and entity metadata work without needing the pre-T0 noise
 *  stream. Player_join events for players who joined pre-T0 are also kept
 *  and rebased — without them, the friend/foe heuristic can't link possess
 *  events to player names.
 *
 *  Returns events unchanged when no player ever spawned (AI-only test
 *  session) or when the first event already is a player char_register. */
function trimToFirstPlayer(events: ReplayEvent[]): ReplayEvent[] {
  let t0 = -1;
  for (const ev of events) {
    if (ev.type === "char_register" && ev.isPlayerControlled) {
      t0 = ev.t;
      break;
    }
  }
  if (t0 <= 0) return events;

  // Snapshot world state at T0. We walk pre-T0 events and keep the latest
  // value for each "current state" stream per entity:
  //   - registration (entity exists + faction/color/name)
  //   - last move (current position + heading)
  //   - last damage_state (alive / incapped / destroyed)
  //   - vehicle_destroyed flag (sticky — destroyed vehicles render as wrecks)
  //   - last vehicle_occupants (crew composition)
  // This way a vehicle that was placed at world boot and never moved still has
  // a position at T0; a stationary AI sentry still has its spawn pose. Drop
  // shots / possesses / etc. from pre-T0 — they're empty-server noise.
  // Deletions clear the entity from every map (it's gone, preserving its
  // last-known state would resurrect it at T0).
  const charReg = new Map<number, Extract<ReplayEvent, { type: "char_register" }>>();
  const charMove = new Map<number, Extract<ReplayEvent, { type: "move" }>>();
  const charDamage = new Map<number, Extract<ReplayEvent, { type: "damage_state" }>>();
  const vehReg = new Map<number, Extract<ReplayEvent, { type: "vehicle_register" }>>();
  const vehMove = new Map<number, Extract<ReplayEvent, { type: "vehicle_move" }>>();
  const vehOccupants = new Map<number, Extract<ReplayEvent, { type: "vehicle_occupants" }>>();
  const vehDestroyed = new Set<number>();
  const playerJoins: Extract<ReplayEvent, { type: "player_join" }>[] = [];
  for (const ev of events) {
    if (ev.t >= t0) break;
    switch (ev.type) {
      case "char_register":
        charReg.set(ev.charId, ev);
        break;
      case "move":
        charMove.set(ev.charId, ev);
        break;
      case "damage_state":
        charDamage.set(ev.charId, ev);
        break;
      case "char_delete":
        charReg.delete(ev.charId);
        charMove.delete(ev.charId);
        charDamage.delete(ev.charId);
        break;
      case "vehicle_register":
        vehReg.set(ev.vehicleId, ev);
        break;
      case "vehicle_move":
        vehMove.set(ev.vehicleId, ev);
        break;
      case "vehicle_occupants":
        vehOccupants.set(ev.vehicleId, ev);
        break;
      case "vehicle_destroyed":
        vehDestroyed.add(ev.vehicleId);
        break;
      case "vehicle_delete":
        vehReg.delete(ev.vehicleId);
        vehMove.delete(ev.vehicleId);
        vehOccupants.delete(ev.vehicleId);
        vehDestroyed.delete(ev.vehicleId);
        break;
      case "player_join":
        playerJoins.push(ev);
        break;
    }
  }

  // Synthesize the new t=0 preface. Registrations and player joins go first
  // so the indexer sees entity metadata before any motion; positions and
  // damage states follow. All rebased to t0 so they land at the new replay
  // start. Shots and possesses from pre-T0 are intentionally discarded.
  const preface: ReplayEvent[] = [];
  for (const ev of playerJoins) preface.push({ ...ev, t: t0 });
  for (const ev of charReg.values()) preface.push({ ...ev, t: t0 });
  for (const ev of vehReg.values()) preface.push({ ...ev, t: t0 });
  for (const ev of charMove.values()) preface.push({ ...ev, t: t0 });
  for (const ev of vehMove.values()) preface.push({ ...ev, t: t0 });
  for (const ev of charDamage.values()) preface.push({ ...ev, t: t0 });
  for (const ev of vehOccupants.values()) preface.push({ ...ev, t: t0 });
  for (const id of vehDestroyed) {
    preface.push({ t: t0, type: "vehicle_destroyed", vehicleId: id });
  }

  const tail: ReplayEvent[] = [];
  for (const ev of events) {
    if (ev.t >= t0) tail.push(ev);
  }

  return [...preface, ...tail];
}

/** Load a replay in chunks, streaming progress as bytes arrive. The first
 *  fetch returns events[0..CHUNK_LIMIT) plus the total event count; subsequent
 *  fetches pull the rest in parallel batches. Reassembled into a single
 *  ReplayData identical in shape to the legacy single-fetch payload, so
 *  indexReplay() doesn't need to know anything about chunking.
 *
 *  Backward-compat: if the server returns the entire payload in one shot
 *  (events.length === totalEvents, or older server without totalEvents),
 *  we skip the chunked phase entirely. */
export async function loadReplay(
  code: string,
  onProgress?: LoadProgress,
): Promise<ReplayData> {
  // First chunk: serves dual purpose. We get the metadata (code, world,
  // meta, created_at) AND the total event count to plan further fetches.
  const firstUrl = `/api/replays/${encodeURIComponent(code)}?offset=0&limit=${CHUNK_LIMIT}`;
  const firstRes = await fetch(firstUrl);
  if (!firstRes.ok) {
    if (firstRes.status === 404) throw new Error("not_found");
    throw new Error(`load_failed:${firstRes.status}`);
  }
  const firstChunk = (await firstRes.json()) as ReplayData & {
    totalEvents?: number;
  };

  const total = firstChunk.totalEvents ?? firstChunk.events.length;
  onProgress?.(firstChunk.events.length, total);

  // Already complete? Either total ≤ chunk size, or the server didn't
  // expose totalEvents (legacy / non-paginated response).
  if (firstChunk.events.length >= total) {
    return {
      code: firstChunk.code,
      world: firstChunk.world,
      meta: firstChunk.meta,
      events: trimToFirstPlayer(firstChunk.events),
      created_at: firstChunk.created_at,
    };
  }

  // Plan remaining chunks. We've already got [0, CHUNK_LIMIT); fetch every
  // subsequent window in batches of PARALLEL_FETCHES.
  const allEvents: ReplayEvent[] = firstChunk.events.slice();
  let nextOffset = CHUNK_LIMIT;

  while (nextOffset < total) {
    const batch: Promise<ReplayEvent[]>[] = [];
    for (let i = 0; i < PARALLEL_FETCHES && nextOffset < total; i++) {
      const offset = nextOffset;
      const url = `/api/replays/${encodeURIComponent(code)}?offset=${offset}&limit=${CHUNK_LIMIT}`;
      batch.push(
        fetch(url).then(async (res) => {
          if (!res.ok) throw new Error(`load_failed:${res.status}`);
          const chunk = (await res.json()) as { events: ReplayEvent[] };
          return chunk.events;
        }),
      );
      nextOffset += CHUNK_LIMIT;
    }
    // Await batch in order so we can append to `allEvents` in document
    // order — events are pre-sorted by `t` server-side, and the index
    // builder defensively re-sorts anyway, but ordered append makes
    // debugging easier and skips an unnecessary shuffle.
    const results = await Promise.all(batch);
    for (const evs of results) {
      for (const ev of evs) allEvents.push(ev);
      onProgress?.(allEvents.length, total);
    }
  }

  return {
    code: firstChunk.code,
    world: firstChunk.world,
    meta: firstChunk.meta,
    events: trimToFirstPlayer(allEvents),
    created_at: firstChunk.created_at,
  };
}
