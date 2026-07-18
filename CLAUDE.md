# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

**`ARCHITECTURE.md`** is the authoritative architecture reference. Read it before making non-trivial changes. It covers: the two independent marker channels (initial markers from Workbench vs. plan markers from the web tool), the tech stack, marker vocabulary, data model, MVP scope, and what is explicitly deferred.

`Project Kick-off.md` is a historical handoff doc — do not rely on it for current decisions; `ARCHITECTURE.md` supersedes it.

## Project shape

The web app (`./web/`) is the shared frontend + HTTP backend for **two complementary Enfusion mods**, both authored in Workbench so they live outside this repo:

1. **`./web/`** — Next.js 16 + React 19 + TypeScript + Tailwind 4 + PostgreSQL (self-hosted). Planning UI **and** replay viewer **and** HTTP backend (`/api/plans/*` and `/api/replays/*`). Production runs at **https://planner.tacticalshift.ru** on the Selectel box (`91.206.15.125`, also the game server) — systemd unit `ts-ops-planner` on `127.0.0.1:3003` behind Caddy, DB `ops_planner` in the box-local PostgreSQL 14. Migrated off Vercel + Neon 2026-07-18 (RU TSPU throttling).
2. **`C:\Users\djdav\Documents\My Games\ArmaReforgerWorkbench\addons\TS Ops Planner\`** — the Enfusion mod that consumes **plans** from the backend. Mod ID `TSOpsPlanner`, GUID `691C96B596D0E373`. Scripts at `Scripts/Game/TS_OpsPlanner/`. Depends on `TS Better Markers` (GUID `686B4A229ED16D71`) for the extended custom-icon set.
3. **`C:\Users\djdav\Documents\My Games\ArmaReforgerWorkbench\addons\TS Replay\`** — the Enfusion mod that **records** gameplay (positions, shots, vehicles, life-states) and POSTs replay events to the backend. Scripts at `Scripts/Game/TS_Replay/`. Recording starts automatically when the server boots — there's no admin command equivalent to `/syncplan`. The web app's "Replay" mode loads + plays back any code stored in the `replays` table.

The `ts-ops-planner.code-workspace` opens the web app and both mod folders.

### Offline tooling — `./tools/map-gen/`

Python scripts used to prepare maps for the web tool. Run from repo root:

- **`grid_stitch.py`** — stitches in-game map screenshots into one big mosaic using the 1km gridlines as ground truth. **Preferred stitcher.** Expects tiles named `RR-CC.png`.
- **`stitch_maps.py`** — older ORB feature-matching stitcher with bundle adjustment. Kept for ad-hoc stitching of non-grid-named input; abandoned for production pipeline because gridline alignment is more precise.
- **`extract_heightmap.py`** — reads a Reforger world's `.terr` + `.ttile` files and emits a raw uint16 `.bin` + JSON sidecar for the web elevation readout.

Dependencies: `opencv-python`, `numpy`, `Pillow`. All via standard `py -m pip install`.

## Common commands

All `npm` commands run from `./web/`.

```bash
npm run dev        # local dev server at http://localhost:3000
npm run build      # production build + type check — use this to validate code changes before deploy
npm run lint       # eslint (Next.js config)
```

Deploy: push to `master` on `github.com/arwelonemusic-byte/ts-ops-planner` (public repo — `Assets/` and `web/public/dev-fixtures/` stay untracked), then on the box run `/opt/ts-web/deploy-ops-planner.sh` (git pull → npm ci → build → restart). Env lives in `/etc/ts-ops-planner.env` (mode 600), never in the repo. The old Vercel flow (`npx vercel deploy --prod --archive=tgz`) is retired.

Backend tests are curl round-trips — there is no test suite yet. POST is behind Basic Auth (`PLANNER_USER`/`PLANNER_PASS` from the env file); GET is public (the 6-char code is the capability token, so the mod ships no secret).

```bash
# POST mints a fresh code server-side; client-supplied codes are still supported for repeat-push iteration (upsert).
curl -sS -u "$PLANNER_USER:$PLANNER_PASS" -X POST https://planner.tacticalshift.ru/api/plans \
  -H "Content-Type: application/json" \
  -d '{"schemaVersion":1,"markers":[{"kind":"custom","worldX":2000,"worldY":2000,"text":"Test"}]}'
# GET needs no auth:
curl -sS https://planner.tacticalshift.ru/api/plans/<code>
```

The mod has no test suite either. Acceptance is "load a scenario with `TS_OpsPlannerSyncComponent` attached to the GameMode in Workbench Play mode, observe marker at expected world coords on the in-game map." Console log prefix is `[TS_OpsPlanner]` — grep for it when diagnosing. The Replay mod uses `[TS_Replay]`.

Replay endpoints (GET-only is public; POST is recorder-only and goes through Basic Auth):

```bash
# Inspect events directly (paginated, default chunk size 20000):
curl -sS "https://planner.tacticalshift.ru/api/replays/<CODE>?offset=0&limit=20000" | jq .events
# List N most recent replays for the dropdown:
curl -sS "https://planner.tacticalshift.ru/api/replays?recent=10"
```

---

# Map pipeline — adding a new terrain

We will do this for every world we support. This is the definitive runbook.

Each map needs three artifacts in `web/public/`:

1. `<name>_final.jpg` — the stitched 2D map image
2. `heightmaps/<name>.bin` + `heightmaps/<name>.json` — elevation data
3. An entry in `web/src/lib/maps.ts` registering the map

Typical effort per map: 1-2 hours of capture + ~5 minutes of scripting.

## Step 0 — Locate the world's terrain source files

The heightmap extractor needs the **unpacked** Workbench data for the world, specifically the `<world>.terr` file and its sibling `.Data/*.ttile` files.

- **Arland**: ships with base Reforger. Unpacked location includes `worlds/Arland/Terrain/Terrain.terr` + `worlds/Arland/Terrain/.Data/Terrain_N.ttile` (N = 0..255).
- **Everon** (internal name **Eden**): distributed as a separate workshop addon, not in the base install. Unpacked location is `worlds/Eden/Eden/Eden.terr` + `worlds/Eden/Eden/.Data/Eden_N.ttile` (N = 0..2499). Note the **different subfolder layout** from Arland — `<world>/<world>/` instead of `<world>/Terrain/`. The extractor handles this automatically via recursive `*.terr` search.
- **Kolguyev** (internal name **Cain**): separate workshop addon. Unpacked layout is `worlds/Cain/Terrain/Terrain.terr` (same nesting as Arland, not Eden). 50×50 tiles of 128 cells each at 2 m cellSize = 6401×6401 vertices.
- **Third-party worlds**: inside whatever folder the mod author used. Extractor auto-locates.

If you don't have it locally, Arma Reforger Workbench will pull it when you subscribe to the corresponding workshop mod. Find the unpacked path after that.

## Step 1 — Capture the 2D map tiles

In-game, in any scenario on the target world, open the map widget. **Fix the zoom level** so the 1km grid (thick black lines) is clearly visible, ~1000 px per km is the sweet spot. Do not change zoom for the rest of the session.

Capture each 1km grid cell with the thick-gridline cell **roughly centered** in the viewport:

- Start at the SW corner (world (0,0)) and capture the bottom-left cell
- Pan east by exactly one 1km cell, capture
- Continue the row east to the SE corner
- Move one cell north, repeat left-to-right
- Continue row-by-row until you've captured the entire grid bottom→top

Things that matter:

- **Clean frame**: no HUD, markers, compass, menu, or any UI overlay. The map widget needs to be the only thing visible.
- **Consistent zoom**: the gridline-based stitcher detects tile-local scale, but dramatic zoom changes between tiles will desync. Don't touch the zoom.
- **Rough centering is fine**: the stitcher detects the thick lines and crops to the exact 1km cell. Being 50-100px off-center adds pixel-level content jitter at seams but doesn't break alignment.
- **Per-tile screen crop can vary**: screenshot tool can capture different areas per tile; the stitcher normalizes via thick-line spacing.

Counts: Arland is 4×4 (16 tiles), Everon is 13×13 (169 tiles), Kolguyev is 13×13 (169 tiles). Plan one cell per world-kilometer.

## Step 2 — Rename tiles to `RR-CC.png`

The stitcher uses the filename as the positional prior. Pattern: `<row>-<col>.png`, zero-padded, row `01` = south, col `01` = west.

One-liner (edit `COLS`):

```python
# Run in the tile directory. COLS = number of columns in your grid.
import os
COLS = 13  # e.g. 13 for Everon, 4 for Arland
files = sorted(f for f in os.listdir('.') if f.lower().endswith('.png'))
for idx, old in enumerate(files):
    row = idx // COLS + 1
    col = idx % COLS + 1
    os.rename(old, f'{row:02d}-{col:02d}.png')
```

This assumes files sort alphabetically in capture order (they will if you used a timestamp-based screenshot tool and captured in the SW→NE order above).

## Step 3 — Stitch

```bash
py tools/map-gen/grid_stitch.py Assets/<Name>-map-tiles \
   -o Assets/<Name>-map-tiles/_stitched.png \
   --target 1000
```

Auto-detects the `RR-CC.png` convention, projects each tile's dark pixels to find thick (1km) vs thin (100m) gridlines, crops each tile to its central 1km cell, resizes to `--target` pixels per km, and butt-joins into a canvas of exactly `(target × cols) × (target × rows)` pixels with zero black borders.

- **`--target 1000` is mandatory.** This yields 1 px/m, which is the invariant the tile pyramid assumes (see gotchas below). Shipping at any other scale breaks heightmap lookup, markers, ruler, and pushed plans for that map.
- `--target 500` (2 m/px) was the historical default before the tile-pyramid transition. It worked for single-image `ImageOverlay` rendering but silently drifts with `TileLayer`. Don't use it for any map you plan to tile.
- Runtime: ~30s for Everon's 169 tiles on a modern laptop.

Expected output log: "Detected px/km" values should cluster tightly (e.g. 986.5-988.5 for a good capture). If the spread is wide or tiles are skipped, some captures are off — recapture those specifically.

## Step 4 — Compress to JPG for the web

```python
from PIL import Image
im = Image.open('Assets/<Name>-map-tiles/_stitched.png').convert('RGB')
im.save('web/public/<name>_final.jpg', 'JPEG', quality=85, optimize=True)
```

JPEG at quality 85 is the right knob — near-invisible quality loss, Everon drops from 30 MB PNG to ~5 MB JPG.

## Step 5 — Extract the heightmap

```bash
py tools/map-gen/extract_heightmap.py "<absolute path to world folder>" \
   -o Assets/Heightmaps/<name> \
   --downsample-m 10
```

The script auto-finds the `.terr` file anywhere under the world folder, reads `HEAD` chunk metadata (grid dims, cell size, height scale, min elevation), then parses every `.ttile`'s `HGHT` chunk and assembles a single 2D uint16 grid. 10m downsample gives Arland ~336 KB, Everon ~3.3 MB.

Outputs:
- `<name>.bin` — raw little-endian uint16 heights, row-major, row 0 = south. **This is the authoritative file the web tool samples.**
- `<name>.png` — 16-bit grayscale debug PNG. Don't ship this to the web; browser canvas reads are 8-bit and lose precision.
- `<name>.json` — metadata sidecar (dimensions, `heightScale`, `minElevationM`, world extent).

Elevation formula applied by the web sampler:
```
elev_m = minElevationM + rawU16 * heightScale
```
where both fields come from the JSON sidecar.

Copy both to web:

```bash
cp Assets/Heightmaps/<name>.bin web/public/heightmaps/
cp Assets/Heightmaps/<name>.json web/public/heightmaps/
```

## Step 6 — Register the map in `web/src/lib/maps.ts`

```ts
{
  key: "<name>",                          // lowercase slug
  label: "<Display Label>",
  imagePath: "/<name>_final.jpg",
  worldBL: [0, 0],
  worldUR: [<widthM>, <heightM>],
  heightmapBin: "/heightmaps/<name>.bin",
  heightmapMeta: "/heightmaps/<name>.json",
},
```

### World-bounds calibration

The stitched image covers exactly `cols × 1km` wide and `rows × 1km` tall. Pick `worldUR` to match the in-game terrain extent:

- If terrain is exactly grid-aligned and your capture set spans it cleanly, `worldUR = [cols * 1000, rows * 1000]` is correct.
- If the terrain's actual extent is off a round number (Arland is 4096m, Everon is 12800m), you can pad to a round grid boundary. Arland is configured at `4100` (4km terrain + 100m padding to land on a clean grid line). Everon is configured at `13000` (13×1km).
- Heightmap meta has `worldWidthM`/`worldHeightM` matching the engine-true extent (`(gridW - 1) * cellSize`) — the sampler uses that independently, so the stitched image's bounds can round without affecting the elevation readout.

Validation: place a marker on an in-game landmark via the web tool, push the plan to Reforger, observe the marker in-game. If there's a **uniform** offset across the map, tweak `worldUR` numbers. If the offset **scales with distance from origin**, the image width/height setting is off — re-check Step 5's `worldBL`/`worldUR` vs what you actually placed.

### UI — map selector

The menu-dots dropdown in the tool switcher has a "Map" section that auto-populates from `MAPS`. No additional wiring needed for a new map to appear in the selector.

## Pipeline gotchas worth remembering

- **Tile pyramid assumes 1 source px = 1 world meter.** `tile_pyramid.py` places tiles at their native pixel scale in Leaflet's CRS.Simple, so the stitched image's pixel dimensions directly determine the map's extent in Leaflet world units. If `<name>_final.jpg` is (say) 3411×3411 px but `worldUR = 4100`, the cursor's latlng drifts by ~20% relative to true world meters — heightmap reads wrong rows, markers land off, ruler reports wrong distances, and pushed plans place markers at wrong in-game coords. Every `<name>_final.jpg` must be exactly `worldUR[0] × worldUR[1]` pixels. Verify with `py -c "from PIL import Image; Image.MAX_IMAGE_PIXELS=None; print(Image.open('web/public/<name>_final.jpg').size)"` before tiling, and regenerate the pyramid if you ever resize the jpg. Arland's 3411×3411 stitch was the bug that surfaced this invariant.
- **The in-game map widget cannot be captured via `System.MakeScreenshot*` APIs** — all three screenshot variants skip the map widget layer. That's why this pipeline captures manually instead of automating via a Workbench plugin. Don't re-try this path.
- **Heightmap row 0 = south (worldY=0), not north.** The sampler in `web/src/lib/heightmap.ts` has this baked in. If you read another world whose convention differs, verify by hovering over a known-flat landmark (airfield runway = great) and seeing if elevation matches.
- **Reforger worlds have inconsistent folder layouts.** Arland nests terrain under `Terrain/`, Eden under `Eden/<world>/`. Extractor uses `rglob("*.terr")` to sidestep this.
- **Feature-matching stitchers don't work for worlds with large water regions.** Water tiles have no distinct features; multiple water tiles look identical. Bundle-adjust variants fail to place them. Always use `grid_stitch.py` with `RR-CC.png` naming for production captures.
- **JPEG artifacts can interfere with stitching.** Captures should be saved as PNG during the stitch pipeline; convert to JPEG only at the final Step 4 for web delivery.
- **Eden ≠ Everon, Cain ≠ Kolguyev.** Internal BI codenames leak into terrain files, prefab references, and scenarios (`Cain.terr`, `Eden.terr`, etc.). Don't rename on import; register them under the display name in `maps.ts` (`everon`, `kolguyev`).

---

## Gotchas outside the map pipeline

- **Next.js 16 is new enough that its APIs may differ from your training data.** If a Next.js pattern feels out of date, check `web/node_modules/next/dist/docs/` rather than guessing. (Captured in `web/AGENTS.md`.)
- **CRS.Simple Y-axis semantics.** Leaflet's `CRS.Simple` places `latLng(maxY, 0)` at the upper-left of the display; `lng = worldX`, `lat = worldY`. When an `ImageOverlay` is placed at bounds `[[0,0],[maxY,maxX]]`, the image's top row renders at world `maxY` and the bottom row at `worldY=0`. That works correctly for a north-up image (image row 0 = north = max worldY). If you ever see the map upside-down, the image was rendered with its row 0 at south instead.
- **Memoize Leaflet props, always.** `worldBounds`, `panBounds`, etc. must be `useMemo`-wrapped by `mapConfig`. A fresh array reference on every render causes `FitWorld`'s `useEffect([bounds])` to fire continuously and reset zoom. This is the `scroll-to-zoom doesn't stick` symptom.
- **`MapContainer key={mapConfig.key}`** is required. Leaflet doesn't hot-swap CRS or bounds cleanly. Keying on `mapConfig.key` forces a remount when switching maps.
- **Heightmap precision via PNG is lossy.** Browser `<canvas>` is 8-bit per channel; reading a 16-bit grayscale PNG drops the low byte, giving ~8m vertical resolution. Ship heights as a raw `.bin` (little-endian uint16), fetched via `ArrayBuffer` + `Uint16Array`.
- **Line drawing's double-click-to-finish collides with Leaflet's zoom.** `doubleClickZoom={false}` is set on `MapContainer`. Use `+`/`-` or scroll to zoom.
- **porsager `postgres` double-encodes string params cast to `::jsonb`.** `sql`...${jsonString}::jsonb`` stores a jsonb *string* (double-encoded), not the parsed object — Neon's driver parsed the same pattern as raw JSON. Always pass the raw JS value through `sql.json(value)`. Symptom was NaN:NaN replay duration: every recorder flush landed as one opaque chunk-string in `events`, and fresh plans stored as strings the mod couldn't parse. Invisible to `next build` and to a POST smoke test unless you check the GET's JSON *type*. Repair pattern for hit rows: `(col #>> '{}')::jsonb` (+ flatten chunk-strings via nested `jsonb_array_elements` for `events`).
- **Coordinate axes in the plan schema.** `worldX, worldY` map to Reforger's engine `(x, z)`, both horizontal. Vertical `y` (height) is not in the schema — the marker system is 2D. Mirrors vanilla `SCR_ScenarioFrameworkSlotMarker.c:108-109`.
- **`SCR_MapMarkerBase` spawn path.** Use `mgr.InsertStaticMarker(marker, false, true)` (server-authoritative, replicates). Not `InsertStaticMarkerByType` — that's client-side only.
- **`RestCallback` lifetime.** Callback must be held by a strong ref for the duration of the async request or it's GC'd mid-flight. The fetcher class in `TS_OpsPlannerSyncComponent.c` owns the callback; the GameMode component owns the fetcher.
- **Static callback signatures.** Reforger's `RestCallback.SetOnSuccess` / `SetOnError` take **static** functions, not instance methods. Data flows back through `cb.GetData()` inside the static function.
- **`MarkerIcon` CSS-mask loses thin-stroke precision at small sizes.** At 24px, a thin DESC-style marker becomes near-invisible because sub-pixel mask anti-aliasing drops opacity. Use `AtlasPreview` (direct background-image) for panel previews where `color` is always white. Map markers can use the mask since they're displayed large enough.
- **Lines are not `SCR_MapMarkerBase`.** They render as `LineDrawCommand`s on a `CanvasWidget` owned by `TS_OpsPlannerDrawingSystem` (client-only `GameSystem` at `ESystemPoint.PostFrame`). The canvas widget is created fresh inside the map frame on every `SCR_MapEntity.GetOnMapOpen()` and destroyed on close. Each frame, if the map panned/zoomed, the system re-projects every line's world points to screen coords via `WorldToScreen`.
- **Line distribution is custom replication.** Markers replicate through `SCR_MapMarkerManagerComponent`; lines don't have an engine path, so `TS_OpsPlannerSyncComponent` owns an RPC + `RplSave`/`RplLoad` pair (single-batch struct-of-arrays payload: `colors[]`, `widths[]`, `pointCounts[]`, `flatPoints[]`). JIPs replay the cached arrays through the same `RpcDo_ReplaceLines` handler the live RPC uses — one reconstruction code path, not two.
- **GameSystem registration requires Workbench-authored conf.** `TS_OpsPlannerDrawingSystem` is registered via `Configs/Systems/ChimeraSystemsConfig.conf` extending the engine's `SystemsConfig.conf` (GUID `{45C53F06BA17238D}`). The conf MUST be created inside Workbench — externally-authored conf files don't commit to `resourceDatabase.rdb`, so the system silently never instantiates. If `World.FindSystem(TS_OpsPlannerDrawingSystem)` returns null at `OnGameModeStart`, the conf wasn't registered; recreate it via Workbench and paste the content.
- **Layouts in `CreateWidgets` need the GUID-prefix form** (`"{GUID}UI/Map/Foo.layout"`, not `"UI/Map/Foo.layout"`). Plain-path still creates the widget but logs `Wrong GUID for resource @{0000...}` every load. Grab the GUID from the `.layout.meta` file.
- **`JsonApiStruct.RegV` does NOT parse `float` scalar fields.** Integer JSON values (like `"widthM":4`) silently leave a `float` field at its default 0 — no error, just zero. Use `int` for scalar numerics and cast to float mod-side if needed. Arrays are different: `ref array<float>` appears to parse integer JSON just fine, so the bug is scalar-specific. Symptoms were: JSON payload correct, cached server-side arrays correct, but the downstream field on each line read 0.
- **Client→server RPCs on GameMode-attached components silently drop.** OnPostInit runs on the server, RplSave/RplLoad work, but a client's `Rpc(Fn, ...)` call to a handler on a GameMode component never fires. Cause: GameMode is server-owned; non-owning client proxies aren't a reliable source for `RplRcver.Server` calls. **Fix:** put the RPC entry point on a PlayerController-attached component (client-owned ⇒ routes cleanly). The server handler gets authoritative caller identity via `PlayerController.Cast(GetOwner()).GetPlayerId()` — unforgeable. Our `TS_OpsPlannerSyncClientComponent` is the relay; it calls into `TS_OpsPlannerSyncComponent.s_Instance.SyncPlan(code)` after the admin check. Precedent: Mission Toolkit's `TS_AdminMessageSenderComponent`.
- **Admin role check for `/syncplan`-style gates must include `GAME_MASTER`.** `SCR_Global.IsAdmin(playerId)` only covers `ADMINISTRATOR` + `SESSION_ADMINISTRATOR`. Game Master mode logins use `EPlayerRole.GAME_MASTER` and get silently rejected otherwise. Check all three via `PlayerManager.HasPlayerRole(pid, role)`.
- **Enfusion's `.layer` serializer omits default values.** A missing field ≠ zero — it's the class-level `[Attribute("<default>", ...)]` from the owning class. Hit this twice on military markers: missing faction = `BLUFOR` (not `UNKNOWN`), missing type modifier = `INFANTRY` (not 0). Any `.layer` parser must map "field absent" to the attribute-declared default, not an enum-zero fallback.
- **Prefab override cascade works via GUID.** Author a mod-side `.et` with the same GUID + path as a vanilla prefab (through Workbench — otherwise it won't commit to `resourceDatabase.rdb`) and every prefab that inherits from that GUID picks up the injected components. Used twice here: `Prefabs/MP/Modes/GameMode_Base.et` (GUID `0F307326459A1395`) for the GameMode component, and `Prefabs/Characters/Core/DefaultPlayerController.et` (GUID `6E2BB64764E3BE9B`) for the PlayerController component. Override the base — not the MP variant — so it cascades to every game mode (SF, Game Master's `DefaultPlayerControllerMP_Factions.et`, etc.).
- **`.layer` files have solo *and* grouped variants for every entity type.** `GenericEntity Name : "{GUID}path"` (solo) vs `$grp GenericEntity : "{GUID}path" { NamedChild1 { ... } NamedChild2 { ... } }` (grouped where multiple named blocks share one prefab ref). Both forms appear for Area / Layer / SlotMarker / PolylineShapeEntity. `PolylineShapeEntity` has a third form — standalone with no prefab ref (`PolylineShapeEntity { ... }`) — which inherits *class* attribute defaults (from `TS_MapOverlayComponent.c`), not prefab overrides. The parser in `web/src/lib/layerImport.ts` handles all variants via independent scans.
- **Two mod-side components, different concerns.** `TS_OpsPlannerSyncComponent` (on GameMode) owns shared state, HTTP fetch, server→all broadcast, JIP replication, and the `s_Instance` singleton. `TS_OpsPlannerSyncClientComponent` (on PlayerController) is a thin client→server RPC relay with the authoritative admin check — calls into `s_Instance.SyncPlan()` once it's past the gate. Both overrides are required for the mod to work.
- **Replay: life-state, NOT damage-state, drives the grey marker.** Subscribing to `SCR_DamageManagerComponent.GetOnDamageStateChanged()` fires DESTROYED on transient hitzone destructions (limb hits, intermediate states during the death sequence) — would grey the marker for non-fatal hits. `SCR_CharacterControllerComponent.m_OnLifeStateChanged` is the authoritative ALIVE / INCAPACITATED / DEAD signal. Emit `UNDAMAGED` on transition→ALIVE (revive) and `DESTROYED` on any non-ALIVE; the web indexer is latest-wins per char, so `ALIVE→INCAP→ALIVE→DEAD` renders correctly without lock-on-DESTROYED special-casing.
- **Replay: position polling must keep running after death.** Earlier code stopped the loop on non-ALIVE; this silently broke incap→revive flows because the marker stayed grey forever (polling never resumed). Now the loop runs until `~SCR_ChimeraCharacter` fires `char_delete`; emit-gating on `isAlive` is internal to each tick.
- **Replay: warhead submunitions inherit `Ammo_Bullet_Base` overrides and emit a phantom shot.** `Warhead_HEAT.et` (rocket) and `Warhead_Grenade_HEDP_M433.et` (HEDP UGL) spawn `SubmunitionEffect` whose prefab traces back through `Ammo_Penetrator_Base.et` → `Ammo_Bullet_Base.et`. Without filtering, that submunition emits a second shot ~30ms after the shell hit at identical coords, visible as a solid line ghost behind the dashed explosion trail. Solution: extend the spall filter in `TS_ReplayProjectileHit.OnEffect` to also drop projectiles whose prefab name `Contains("Penetrator")`. Other vanilla naming conventions worth knowing: `"Spall"` (frag scatter, was the original filter target).
- **Replay: per-prefab attributes ARE per-prefab.** Each prefab override gets its own `TS_ReplayProjectileHit` component instance with its own attribute values, even though they share the class. Verified by inspecting two override files (`Ammo_Bullet_Base.et` and `Warhead_Grenade.et`) — distinct GUIDs for the component instances. So a checkbox attribute like `m_bIsExplosion` is settable independently per ammo prefab via the Workbench Inspector.
- **Replay: per-projectile entity dedup catches ricochets, not cross-prefab dual-emit.** `EmitShot` keeps a recent-projectiles `array<IEntity>` (TTL 2s) and skips events whose `damageSource` was already seen — fixes the M249 belt fanning where each round's `OnEffect` fires multiple times (initial impact + ricochet). Does NOT catch the shell+warhead dual-emit problem (different `IEntity`s); that's the prefab-name filter's job.
- **Replay: bool emission via `BoolToJson` helper.** Enforcement Script has no ternary, so the recorder uses an `if` to branch between `"true"`/`"false"` strings (see `EmitCharRegister.isPlayerControlled` and `EmitShot.isExplosion`). Don't try `condition ? "true" : "false"` — won't compile.
- **Replay: `Faction.GetFactionColor()` returns `Color` floats.** `c.R()` / `.G()` / `.B()` are `[0,1]` floats — multiply by 255 and bit-shift into `0xRRGGBB`. Fallback to 0 when the faction or color is missing; the web side treats 0 as "no color, use heuristic" (tier 3).
- **Tailwind v4 / Lightning CSS strips vendor-prefixed pseudos from unlayered CSS.** `::-webkit-slider-runnable-track`, `::-webkit-slider-thumb`, `::-moz-range-*`, custom `@keyframes`, and broad preflight overrides (e.g. `button:not(:disabled) { cursor: pointer }`) silently disappear because the optimizer thinks they're redundant vendor prefixes. Wrap them in `@layer base` to keep them.
- **Lightning CSS folds `var(--x, fallback)` when the fallback statically resolves the rule.** A slider track `linear-gradient(... var(--pct, 0%) ...)` collapses to a single color because `0%` makes the gradient one-tone. Drop the fallback so the optimizer can't resolve at parse time — runtime always provides the value.
- **React 19 strict mode runs `useState` updaters twice in dev.** Updaters must be pure — calling `setOther(...)` inside `setX((v) => ...)` fires the side-effect setter twice and trips "Maximum update depth exceeded". Compute next state purely; react to it in a separate `useEffect`.
- **`useEffect` dep arrays must not include raw JSX values** (e.g. `currentPanelBody`). JSX nodes are fresh references each render, so the effect re-runs every render and any state-setting inside cascades into a render storm. Use a derived boolean (`!!currentPanelBody`) when only mount state matters.
- **react-leaflet `<Tooltip>` doesn't survive per-frame `setIcon` swaps.** Replay chars/vehicles update their DivIcon every RAF tick (yaw + position); `marker.setIcon(newIcon)` destroys + recreates the DOM element and Leaflet's tooltip close logic loses track, leaving hover labels stuck. Inline the hover label into the DivIcon HTML and gate via CSS `:hover` instead (see `.ts-replay-name-hover` / `.ts-replay-veh-hover` in `globals.css`). CSS re-evaluates against whichever element is mounted now — stale state is impossible by construction.
- **`vercel env pull` defaults to development scope** (historical — app is off Vercel since 2026-07-18). Sensitive-flagged vars pull back empty in *any* scope; the old Neon `DATABASE_URL` was only retrievable from the Neon console.
- **Git Bash mangles `/PID`-style flags** into absolute paths (`/PID` → `C:/Program Files/Git/PID`). Use double-slash (`taskkill //F //PID <n>`) or prefix the command with `MSYS_NO_PATHCONV=1`.
- **Orphaned `next dev` symptom**: `GET /api/replays?recent=N` returns 200 but `GET /api/replays/[code]` returns 500 with `Jest worker encountered N child process exceptions` in the log. The orphan process is alive but its API-route worker pool is dead — kill the PID Next.js reports in its "Another next dev server is already running" message, then restart.
- **`web/public/dev-fixtures/<CODE>.json` are served by `lib/replayFixtures.ts` when `DATABASE_URL` is empty.** Drop a payload from prod `/api/replays/<code>?offset=0&limit=N` (merged across chunks) to add a new fixture; recent-list and detail endpoints both fall back to fixtures automatically.
- **`MaskIcon` (in `components/MarkerIcon.tsx`) recolors an SVG via CSS `mask-image`.** The SVG's own `fill` values are ignored — the rendered color is whatever you pass to the `color` prop. Source SVGs can ship with any fill color; only the alpha matters.

## Replay (TS Replay mod)

Recording is **automatic at server boot** — no admin command. The recorder lives on the GameMode component as `TS_ReplayRecorder.s_Instance`, batches events in memory, and POSTs them every `flushIntervalSec` (default 5s).

### Components

- **`TS_ReplayRecorder`** (server-only singleton on GameMode) — owns the pending-events buffer, HTTP fetcher, and shot-dedup state. All emitter methods (`EmitMove`, `EmitShot`, `EmitVehicleRegister` etc.) flow through here. Configuration is loaded once at boot from `$profile:ts_replay.json` via the `TS_ReplayConfig` `JsonApiStruct`.
- **`SCR_ChimeraCharacter` modded** (`TS_ReplayChimeraCharacter.c`) — `EOnInit` auto-registers every char (player + AI) with one frame of deferral and a bounded retry for late-assigned factions. Installs hooks for `m_OnLifeStateChanged` (NOT damage-state — see gotcha) and a self-rescheduling position log loop that emits at `pollIntervalMs` for players, `aiPollIntervalMs` for AI.
- **`TS_ReplayProjectileHit`** (`BaseProjectileEffect` subclass) — added to projectile prefab override `ProjectileEffects` arrays. Two per-prefab attribute checkboxes: `m_bIsExplosion` (frag/UGL/rocket → renders as line+circle) and `m_bIsHeavyExplosion` (rocket → thicker dashed line). Filters spall and penetrator submunitions by name match on the projectile's prefab path.
- **`TS_ReplayVehicleComponent`** (modded `SCR_EditableVehicleComponent`) — auto-registers every vehicle, polls position+occupants, hooks vehicle damage state for the destroyed-grey marker.
- **`TS_ReplayPlayerController`** + **`TS_ReplayPossessHook`** — emit `player_join` and `possess` events.

### Schema

Events are an unordered append-only stream tagged by `type`:

| type | shape (relevant fields) |
|---|---|
| `player_join` | `{playerId, playerGuid, name}` |
| `char_register` | `{charId, factionKey, isPlayerControlled, factionColor}` — `factionColor` is `0xRRGGBB`, sourced from `Faction.GetFactionColor()` |
| `possess` | `{playerId, charId}` |
| `move` | `{charId, x, z, yaw}` — 2D, `y` (height) dropped |
| `damage_state` | `{charId, state}` — `EDamageState`: `UNDAMAGED=0`, `DESTROYED=2` |
| `char_delete` | `{charId}` |
| `shot` | `{shooterCharId, originX, originZ, hitX, hitZ, isExplosion, isHeavy}` |
| `vehicle_register` / `vehicle_move` / `vehicle_occupants` / `vehicle_destroyed` / `vehicle_delete` | analogous |

### Friend/foe color resolution (`web/src/lib/replay.ts:resolveCharHex`)

Three tiers, in order:
1. **Destroyed** → grey (overrides everything).
2. **`factionColor` from `char_register`** → use directly. This is the modern path; every fresh recording resolves here for every char.
3. **Identity heuristic** → blue if the char was ever possessed by a known player, red otherwise. `friendlyFactionKey` (config) biases this for PvP. Tier 3 only fires for legacy replays predating the factionColor field, or for mod factions whose `Faction.GetFactionColor()` returns null.

### Web-side trim

The recorder runs from server boot, so a typical session has 10–20 minutes of empty-server activity before any human appears. `loadReplay()` (`web/src/lib/replay.ts`) trims this **at load time** — pure web-side, retroactively applies to every replay in the DB:

- T0 = first `char_register` event with `isPlayerControlled === true` (the moment a player first spawns into a body, NOT first connection — there's a slot-pick gap).
- Pre-T0 events are dropped, except: latest registration / move / damage_state / vehicle_occupants / vehicle_destroyed per still-alive entity is **rebased to `t = t0`** so the indexer sees the world snapshot at T0. Stationary AI sentries and vehicles parked at boot would otherwise have no position post-trim.
- Pre-T0 `player_join` events are also rebased to t=t0 so player-name lookups still resolve for the friend/foe heuristic.
- Returns events unchanged if no player ever spawned (AI-only test session).

### Explosion rendering

Two-flag system on `TS_ReplayProjectileHit`, set per prefab override in Workbench:

| Prefab | `m_bIsExplosion` | `m_bIsHeavyExplosion` | Visual |
|---|---|---|---|
| `Ammo_Bullet_Base.et` | ☐ | ☐ | solid line |
| `Warhead_Grenade.et` (frag) | ☑ | ☐ | thin dashed line + blast circle |
| `Ammo_GrenadeLauncher_Base.et` (UGL) | ☑ | ☐ | thin dashed + circle |
| `Ammo_Rocket_Base.et` | ☑ | ☑ | thicker dashed (3px, "8 8" gap) + circle |
| smoke / no override | n/a | n/a | nothing emitted |

Frag overrides are at the **warhead level** because hand-thrown frags detonate by fuse, not collision. UGL and rocket overrides are at the **shell level** (the ProjectileEffects on `ShellMoveComponent` / `MissileMoveComponent`).

### Configuration

`$profile:ts_replay.json` (loaded by `TS_ReplayConfig`):

| key | default | purpose |
|---|---|---|
| `flushIntervalSec` | 5 | batch POST cadence |
| `pollIntervalMs` | 1000 | player char position-sample period |
| `aiPollIntervalMs` | 0 | AI char period; 0 → fall back to `pollIntervalMs` |
| `moveDeltaM` | 0 | stationary dedup distance threshold (m); 0 disables |
| `moveYawDeltaDeg` | 0 | stationary dedup yaw threshold (deg); 0 disables. Both must be > 0 for suppression to engage |
| `friendlyFactionKey` | "" | PvP override for tier-3 friend/foe; empty is fine for any modern recording |
| `pollRadiusM` | 500 | reserved (proximity AI filter not wired) |

For long ops with lots of AI: `aiPollIntervalMs: 3000`, `moveDeltaM: 1`, `moveYawDeltaDeg: 5`.

### Pagination

The Vercel Hobby tier caps serverless response bodies at ~4.5 MB; long ops easily exceed that. `GET /api/replays/[code]?offset=N&limit=M` slices via SQL-side `jsonb_array_elements WITH ORDINALITY` so the function memory stays bounded. `loadReplay()` requests the first chunk (returns `totalEvents`), then pulls remaining chunks in parallel batches of 4. Pre-pagination behaviour (entire payload in one shot) is still supported for small replays / legacy clients.

## Localization

User-facing strings go through `useT()` from `src/components/LanguageProvider.tsx`; translations live in `src/lib/i18n.ts` (EN/RU, flat key-based dictionary). Don't hardcode new UI strings — add a key and both-language entries. Brand names ("TS Markers") and data labels that originate outside the UI (faction keys, map names, color names from `markerLibrary.ts`) stay English regardless of locale. Locale persists to `localStorage` under `ts-ops-planner-locale-v1` and updates `<html lang>`; Cyrillic subset is loaded via `next/font/google` in `app/layout.tsx`.

## Web UI conventions (Figma-sourced)

The panel UI is designed to match Figma file `hHh1bKwcTXbhuwOVnoP1ZL`. Key tokens:

- Container bg: `#202427`; deeper-inset bg (inputs, tab track): `#14181a`; inactive button bg: `#2e3439`
- Primary yellow accent: `#f4db50`; destructive red: `#f26f63`
- Text: white / white60 / white30 hierarchy
- Fonts: Roboto Slab 500 @ 24px for H1s; Roboto 400 @ 14px for body; Roboto 500 @ 13px for buttons/tabs. Loaded via `next/font/google` in `layout.tsx`, exposed as `--font-roboto` and `--font-roboto-slab` and mapped to Tailwind's `font-sans` / `font-slab`.
- Panel corner 12px; inset elements 4-6-8px. Panel internal padding 24px, between-panel gap 16px.
- Color palette (14 swatches, 7×2 grid) is Figma-defined — keep `markerLibrary.ts` COLORS aligned with `scripts/extract-markers.mjs` or both drift.
- Icons downloaded from Figma live in `web/public/icons/figma/`; render single-color ones via the `MaskIcon` helper so we can recolor them by CSS.

## Data model at a glance

Two tables in the box-local PostgreSQL (database `ops_planner`), one row per saved artefact each:

```
plans(   code TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())
replays( code TEXT PRIMARY KEY, world TEXT, meta JSONB, events JSONB, created_at TIMESTAMPTZ DEFAULT NOW())
```

`plans.data` stores the full plan JSON as posted. `replays.events` is the unordered append-only event stream; `replays.meta` carries `startedAt`, `terrainResource`, `friendlyFactionKey` etc. (see `ReplayMeta` in `web/src/lib/replay.ts`). The recorder keeps appending to the same row throughout the session (`UPDATE replays SET events = events || $1`). Short codes are 6 chars from a curated alphabet (`src/lib/code.ts`). **Production flow: the server mints a fresh code per POST**; the client omits `code` from the body and reads the returned `{ code }` to show the commander. Client-specified codes are still accepted for test-iteration / repeat-push to a known code (upsert semantics).

The web tool POSTs plans with:
```json
{
  "schemaVersion": 1,
  "markers": [ /* see TS_OpsPlanMarker */ ],
  "lines":   [ /* { colorHex: "#rrggbb", widthM: <meters>, points: [x0,y0,x1,y1,...] } */ ]
}
```

The mod's `TS_OpsPlan`, `TS_OpsPlanMarker`, and `TS_OpsPlanLine` `JsonApiStruct` classes must stay in sync with the fields the web tool emits. Unregistered JSON keys are silently ignored — convenient, but means a renamed field fails silently on the mod side.

**Line schema is deliberately engine-unit-native.** `widthM` is world meters (not the web UI's 1-5 slider index) and `colorHex` is an sRGB hex string (not a palette name like `RED`). That keeps the mod out of the business of replicating UI mappings. `points` is flat `[x0, y0, x1, y1, ...]` because Enfusion's `JsonApiStruct` handles `ref array<float>` cleanly; nested tuples (`[[x,y],...]`) would force a side struct.

## The two marker channels — do not conflate them

| | Initial markers | Plan markers |
|---|---|---|
| Authored | Mission maker in Workbench `Markers.layer` | Op commander in the web tool |
| Enters game via | Scenario framework at mission start (vanilla) — the mod never touches these | `/syncplan <code>` admin command → `InsertStaticMarker` |
| Backend involved | No | Yes |

Changes to one should not affect the other. In particular, the mod never spawns "initial" markers; they're already in the game because the scenario framework placed them.

## Currently supported worlds

| World | `worldUR` | Status |
|---|---|---|
| Arland | `[4100, 4100]` | Image ✓ · Heightmap ✓ |
| Everon (Eden) | `[13000, 13000]` | Image ✓ · Heightmap ✓ |
| Kolguyev (Cain) | `[13000, 13000]` | Image ✓ · Heightmap ✓ |

Adding another is the whole reason the pipeline above is documented.

## Deferred, not forgotten

- **Multi-world support on the mod side.** Plan schema has no `world` discriminator yet. Web tool persists map selection but doesn't send it. When the mod renders plans for multiple worlds, add a `world` field to the POST body and verify match before spawning.
- **Hot-edit / live resync / polling.** Currently the mod only pulls on `/syncplan`.
- **Clear-and-replace marker tagging survives scenario restart.** Today the "plan-origin markers" list is an in-memory registry on `TS_OpsPlannerSyncComponent`; a scenario restart mid-plan loses it, so stale markers from a prior `/syncplan` can linger. Needs a durable tag (e.g. marker text prefix or a custom attribute) so re-sync can wipe-by-tag.
- **Rate limiting** on the web API. Basic Auth covers POST; GET code-brute-force is a ~500M-combo keyspace and economically infeasible, but serverless-friendly rate limiting (Upstash Redis / Vercel KV) is still worth adding if abuse appears.
- **Paste-fallback UI** for when the backend is down.
- **Polygon sync to in-game.** Polygons are import-only today (read-only display of `TS_MapOverlay` zones parsed from the mission maker's `.layer`). Commander-drawn polygons that replicate to game aren't implemented.
- **Per-tile pyramids for large maps.** Everon / Kolguyev at 13MP are served as single ~5 MB JPGs. Leaflet's tile pyramid would smooth high-zoom pan/zoom.
- **Replay: Discord auth replacing Basic Auth.** Confirmed scoped out for now; revisit if the user base grows.
- **Replay: heavy-ordnance coverage for mortars / artillery.** `Ammo_MortarShell_Base.et` is overridden but mortars haven't been smoke-tested. `Warhead_HEAT_*` variants beyond `Warhead_HEAT_PG7VM` are also untested for exotic launchers.
- **Replay: live in-game review.** Today the replay viewer is web-only post-game. Streaming a live session to the web tool while a match is in progress would let an observer follow along, but isn't on the roadmap.
- **Replay: storage size cleanup.** Long ops (90+ min, 30+ AI) approach the Neon free-tier quota. Trimming dead air is web-side only — the underlying rows still carry the full event stream. A periodic compaction job that rewrites `replays.events` to drop pre-T0 entries would reclaim space.

Don't build these preemptively.
