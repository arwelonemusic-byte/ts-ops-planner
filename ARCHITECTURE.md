# TS_OpsPlanner — Architecture

**Status:** Architecture locked, Stage 0 not yet started.
**Last updated:** 2026-04-14
**Supersedes decisions in:** `Project Kick-off.md` (kept as historical handoff; this doc is authoritative going forward)

---

## 1. Problem

Players waste 10–15 minutes per mission placing markers, drawing compound outlines, setting TRPs. Non-planners sit idle. The fix: pre-plan the operation on a web tool, then sync the plan into the game with one admin command at mission start.

## 2. System overview

Three independent components, two independent marker channels. **Do not conflate them.**

```
┌──────────────────────────────┐
│  1. Workbench                │
│     Mission Maker places     │
│     markers in Markers.layer │
└──────────────┬───────────────┘
               │
   (a) Scenario Framework spawns initial markers in-game automatically at mission start
               │
   (b) Workbench plugin exports Markers.layer → JSON file
               │
               │ (manual copy/paste)
               ▼
┌──────────────────────────────┐
│  2. Web Tool (Next.js)       │
│     - Displays initial       │
│       markers as read-only   │
│       baseline               │
│     - Op Commander places    │
│       plan markers on top    │
│     - Saves plan to backend  │
│       under short code       │
└──────────────┬───────────────┘
               │
               │ HTTPS (Vercel API + Neon)
               ▼
┌──────────────────────────────┐
│  3. Reforger Mod             │
│     Admin: /syncplan ABC123  │
│     → HTTP GET plan          │
│     → Spawn plan markers     │
│     (initial markers already │
│     in-game from scenario)   │
└──────────────────────────────┘
```

### Two marker channels — do not merge

| | Initial markers | Plan markers |
|---|---|---|
| **Authored by** | Mission Maker (Workbench) | Op Commander (web tool) |
| **Storage** | Mission `.layer` file | Vercel Neon DB |
| **Enters game via** | Scenario Framework at mission start (we don't touch this) | `/syncplan` admin command at session start |
| **Enters web tool via** | Workbench plugin → JSON export → manual paste | Authored directly in the tool |
| **Mutable in-session?** | No (part of mission) | Yes — `/syncplan` can be re-run with clear-and-replace |
| **Backend involved?** | No | Yes |

**The mod never spawns initial markers.** They're already in the game, placed by the scenario framework. The mod only handles plan markers.

## 3. Tech stack

**Web tool + backend** — Vercel project, mirroring the existing `training-portal` stack:
- Next.js 16, React 19, TypeScript, Tailwind
- `@neondatabase/serverless` for Postgres
- Leaflet with `CRS.Simple` for the map
- Deployed to Vercel; API routes colocated with the UI

**Database schema** (Neon, one table):
```sql
CREATE TABLE plans (
  code       TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**API endpoints:**
- `POST /api/plans` — body is the plan JSON. Generates short code, inserts, returns code.
- `GET /api/plans/:code` — returns the stored JSON or 404.

**Reforger mod** — `TS_OpsPlanner`:
- Enforce Script
- Depends on `TS Better Markers` (for the extended icon entry set)
- Uses `GetGame().GetRestApi().GetContext(...)` for HTTP
- Uses `JsonApiStruct` for JSON parse
- Uses `SCR_MapMarkerManagerComponent.InsertStaticMarker(...)` for spawning

**Workbench plugin** — parses `Markers.layer` files and exports JSON matching the initial-markers schema.

## 4. Marker vocabulary

The player-facing marker system in Reforger is **config-driven, not enum-driven**. The web tool must mirror the game's player palette, which is the union of:

- Vanilla `SCR_MapMarkerConfig.m_aPlacedMarkerIcons` entries
- `TS Better Markers` additions (the `"ts"` category: TRP, FUP, MEP, CP, BP, AOA variants, hold, penetrate variants, etc.)

### Marker type taxonomy

| Type | Fields | Underlying in-game shape |
|---|---|---|
| **Custom** | `iconCategory` (e.g. `"ts"`, `"default"`), `iconQuad` (e.g. `"ts-trp"`), `color` (from `SCR_EScenarioFrameworkMarkerCustomColor`), `text` | `SCR_EMapMarkerType.PLACED_CUSTOM` + `SetIconEntry(...)` + `SetColorEntry(...)` |
| **Military** | `factionIcon` (from `EMilitarySymbolIdentity`), `type1Mod`, `type2Mod`, optional `text` | Built via `SCR_MapMarkerManagerComponent.PrepareMilitaryMarker(...)` |

Stable identifier for a custom icon = `(iconCategory, iconQuad)` tuple. Human-readable, mod-stable, resolvable at spawn time to a `SCR_MarkerIconEntry`.

### Initial markers use a narrower vocabulary

`Markers.layer` uses the scenario framework's `SCR_EScenarioFrameworkMarkerCustom` enum (FLAG, ENTRY_POINT, MARK_EXCLAMATION, DOT, …) for custom markers. The Workbench plugin must map these enum values to `(iconCategory, iconQuad)` tuples — most likely all in the vanilla/default category — so the web tool has one consistent vocabulary for display.

## 5. Data model

### Initial markers (Workbench → tool)

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-04-14T00:00:00Z",
  "world": "everon",
  "markers": [
    {
      "kind": "custom",
      "worldX": 3845,
      "worldY": 2975,
      "iconCategory": "default",
      "iconQuad": "entry-point",
      "color": "BLUFOR",
      "text": "Start"
    },
    {
      "kind": "military",
      "worldX": 3975,
      "worldY": 2814,
      "factionIcon": "OPFOR",
      "text": ""
    }
  ]
}
```

Walked from `Markers.layer`:
- `SCR_ScenarioFrameworkArea` entities contribute their `coords` as an origin.
- Nested `SlotMarker` entities contribute `coords` relative to that origin.
- `worldX = round(parent.x + child.x)`, `worldY = round(parent.z + child.z)` — the Workbench `y` axis is height and is discarded.
- `SCR_ScenarioFrameworkMarkerCustom` → `kind: "custom"`, enum → tuple lookup.
- `SCR_ScenarioFrameworkMarkerMilitary` → `kind: "military"`.

### Plan (tool → backend → mod)

Same shape, no `world` field if single-terrain MVP, plus a planner-owned tag that lets the mod implement clear-and-replace:

```json
{
  "schemaVersion": 1,
  "code": "ABC123",
  "markers": [ /* same marker shape as above */ ]
}
```

## 6. MVP scope

**In scope for v1:**
- Everon only
- Single marker type per sync (custom + military both supported, but v1 proves with custom only)
- Admin-gated `/syncplan <code>` command
- Clear-and-replace: a re-sync wipes prior plan-origin markers and inserts the new set. Initial markers untouched.
- Workbench plugin that exports `Markers.layer` to JSON
- Web tool: Leaflet map, click-to-place custom markers, save to backend, paste initial-markers JSON as context

**Explicitly deferred:**
- ~~Polyline/area overlays.~~ **Shipped.** Lines now render mod-side via `TS_OpsPlannerDrawingSystem` (client-only `GameSystem`) using `CanvasWidget` + `LineDrawCommand`. See `CLAUDE.md` gotchas section.
- Hot-edit / live resync / auto-polling
- Multi-terrain support (plan payload would need a `world` discriminator, web tool a tileset switcher)
- Server-issued short codes with collision handling (v1 can accept client-picked codes if simpler)
- Formal auth (v1 may use no write-token; relies on obscurity of the code)
- Rate limiting
- Paste-fallback in-game textbox

## 7. Plan-marker tagging for clear-and-replace

The mod needs to identify its own prior markers to clear them without touching initial markers. Candidate approaches (pick at implementation time):

1. **Config ID encoding** — `InsertStaticMarkerByType` takes a `configId` parameter. Reserve a planner-specific config ID.
2. **Runtime registry** — mod keeps an in-memory list of marker IDs it inserted. Next sync wipes them first.
3. **Marker text prefix** — crude but effective. Prefix all plan markers with invisible token or metadata. Discouraged if cleaner options work.

Pick whichever is cheapest to implement once the vanilla insert path is proven.

## 8. Prototyping plan

### Stage 0 — backend + mod, no web tool

Goal: prove every seam in the Tool→Game pipe with the minimum moving parts.

1. Stand up the Vercel project. Two API routes. Add the `plans` table to Neon.
2. With `curl`, POST a hardcoded plan JSON under a fixed key `TEST01`:
   ```json
   {
     "schemaVersion": 1,
     "code": "TEST01",
     "markers": [
       {
         "kind": "custom",
         "worldX": 2000,
         "worldY": 2000,
         "iconCategory": "default",
         "iconQuad": "flag",
         "color": "BLUFOR",
         "text": "Test"
       }
     ]
   }
   ```
3. Verify `GET /api/plans/TEST01` returns the JSON.
4. Scaffold `TS_OpsPlanner` mod. Depends on `TS Better Markers`.
5. Implement sync component: admin command `/syncplan <code>` → `RestContext.GET` → `JsonApiStruct` parse → `InsertStaticMarker`.
6. **Acceptance:** on a dedicated server with the mod loaded, running `/syncplan TEST01` spawns a single marker at world (2000, 2000) — visible as a gridline intersection 2km east and 2km north of Everon's (0,0) corner. Visible to all connected clients.

### Stage 1 — add the web tool

1. Leaflet + `CRS.Simple` + Everon tileset in the Next.js app.
2. Click-to-place a single custom marker (hardcoded icon + color for now).
3. "Save" button POSTs to `/api/plans`, returns a code.
4. Re-run `/syncplan <code>` in-game; marker appears at the clicked location.
5. **Acceptance:** clicking at a visually identifiable spot on the web map (e.g. Montignac square) and syncing in-game spawns the marker at that exact spot.

### Stage 2 — breadth

- Multiple marker types, full custom-icon palette (vanilla + TS Better Markers)
- Military markers
- Initial-markers paste UI and baseline rendering in the web tool
- Workbench plugin for `Markers.layer` export
- Admin gate (GameMaster role)
- Clear-and-replace semantics

## 9. Open questions to resolve during implementation

- **`SetIconEntry` signature** — int index into the config array, `SCR_MarkerIconEntry` reference, or GUID string? Needed before we can sync a custom-icon marker from a `(category, quad)` tuple. Verify before Stage 1 wraps.
- **Framework enum → icon entry mapping** — is there a vanilla lookup we can call, or do we maintain a small hand-written table? Needed for the Workbench plugin. Not on the Stage 0 critical path.
- **HTTPS enforcement by Reforger's RestApi** — assumed yes. Verify at Stage 0 step 5 by trying an HTTPS URL first. If HTTP is accepted we don't care; if only HTTPS, Vercel gives us that for free.
- **Short-code generation strategy** — client-picked vs server-generated. Defer until the web tool "new op" flow is being built.

## 10. References

- BI Wiki — REST API Usage: https://community.bistudio.com/wiki/Arma_Reforger:REST_API_Usage
- BI Wiki — JsonApiStruct Usage: https://community.bistudio.com/wiki/Arma_Reforger:JsonApiStruct_Usage
- `TS Mission Toolkit` — `C:\Users\djdav\Documents\My Games\ArmaReforgerWorkbench\addons\TS Mission Toolkit\` (conventions, Enforce Script gotchas)
- `TS Better Markers` — `C:\Users\djdav\Documents\My Games\ArmaReforgerWorkbench\addons\Unpacked\TS Better Markers\` (custom icon entries)
- Operation Fury Road `Markers.layer` — `C:\Users\djdav\Documents\My Games\ArmaReforgerWorkbench\addons\Operation Fury Road\Worlds\fury-road_Layers\Markers.layer` (canonical example of authored initial markers)
- Existing Vercel stack reference — `D:\VSCode_dev\tactical-shift-improvement-project\training-portal\` (Next.js + Neon template we'll mirror)
