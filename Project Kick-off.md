# Context Handoff - 2026-04-14

## Current Project / Plan

**New mod: Web-Based Operation Planner for Arma Reforger** (working name: `TS_OpsPlanner` or similar — final name TBD).

The idea: players waste 10–15 min of game time at mission start placing markers, outlining compounds, setting TRPs, etc., while non-planners sit idle. Build a **web-based planning tool** where the operation can be pre-planned in advance, then **synced into the game map** at mission start with one command. Web tool produces a plan identified by a short code; in-game admin command fetches the plan over HTTP and spawns the markers.

Decision already made: this is a **separate mod** from `TS Mission Toolkit`, not part of it. It will *depend on* the toolkit for shared types (specifically the marker enum), but it ships its own HTTP client, web backend dependency, and admin UI. The toolkit stays as mission-building primitives that every downstream mission inherits — forcing all of them to ship HTTP and a planner UI they may never use is the wrong default.

The new mod and VS Code project are being created by the user right now. This handoff is for the first working session in that new project.

## Current Phase

**Pre-implementation / architecture locked-in.** No code written yet. Research is done (see Decisions Made below). The next session should start by scaffolding the new mod project and building the thinnest vertical slice.

## Work Completed This Session

Research via Enfusion MCP + Arma Reforger MCP confirmed the three technical unknowns that shape the whole architecture:

1. **HTTP from script is sanctioned and documented.** `GetGame().GetRestApi().GetContext("https://your-api/")` returns a `RestContext` with async GET/POST/PUT/DELETE + success/error/timeout callbacks via `RestCallback`. Limits: payloads <1MB, no custom headers, GET/POST primarily. Wiki: https://community.bistudio.com/wiki/Arma_Reforger:REST_API_Usage
2. **JSON (de)serialization is built-in.** `JsonApiStruct` — declare a class, call `RegV("fieldName")` per field in the constructor, get bidirectional string↔object conversion. Nested structs supported. Wiki: https://community.bistudio.com/wiki/Arma_Reforger:JsonApiStruct_Usage
3. **Map markers are a first-class vanilla system.** `SCR_MapMarkerManagerComponent.GetInstance()` on the GameMode entity exposes `InsertStaticMarkerByType(SCR_EMapMarkerType type, int worldX, int worldY, bool isLocal, int configId=-1, int factionFlags=0, bool isServerMarker=false)`. Takes **world coordinates directly**, handles replication to all clients, handles faction-flag visibility. No custom entity spawning required.

These three findings collapsed what the user thought would be "the hardest part" (sync) into a straightforward pipe: HTTP GET → `JsonApiStruct` parse → loop `InsertStaticMarkerByType`.

Also confirmed `FileIO` exists but is restricted to `$profile:`, `$logs:`, `$saves:` — useful for caching, not for sync.

## Key Files

None yet in the new mod. Reference material from the existing toolkit:

- `C:\Users\djdav\Documents\My Games\ArmaReforgerWorkbench\addons\TS Mission Toolkit\CLAUDE.md` — project conventions, Enforce Script gotchas, replication notes. New mod should follow the same conventions (`TS_` prefix, localization keys, etc.).
- `C:\Users\djdav\.claude\CLAUDE.md` — global instructions; flags the no-ternary Enforce Script gotcha.
- BI wiki REST API page (URL above) — read before writing the HTTP client.
- BI wiki JsonApiStruct page (URL above) — read before writing the plan schema.

## Decisions Made

1. **Separate mod, not part of TS Mission Toolkit.** Toolkit is primitives every mission inherits; planner is opt-in. Planner *depends on* toolkit for shared types (marker enum).
2. **Mirror `SCR_EMapMarkerType` exactly in the web tool** — don't invent a marker set. Web tool dropdown is the enum; payload carries the raw int; mod passes it straight to `InsertStaticMarkerByType`. One-to-one parity by construction.
3. **Sync mechanism: HTTP pull, not paste/file.** Web tool POSTs plan to a tiny backend (Cloudflare Workers + KV, Supabase, or similar) keyed by a short code (e.g., `ABC123`). In-game admin runs `/syncplan ABC123` → mod does `ctx.GET(...)` → parse → spawn markers.
4. **Map tool stack: Leaflet with `CRS.Simple`.** Everon is 12,800m square, origin (0,0) at a corner — meters↔pixels is a fixed linear ratio, no projection math. Tile map from Workbench terrain export or stitched in-game map screenshots.
5. **MVP scope:** Everon only, vanilla marker enum only, no polygons/compound outlines, admin-only `/syncplan <code>` command, clear-and-replace semantics (new sync wipes prior planner-tagged markers). Prove the pipe end-to-end first.
6. **Auth:** No custom headers supported, so write-token goes in POST body or URL path. Read-by-code + rate limiting is enough for plan fetches; plans aren't sensitive.
7. **Fallback for backend downtime:** Allow admin to paste a JSON blob directly into a textbox as a manual override if HTTP fetch fails. Don't let a dead backend brick a session.

## Open questions deferred to later phases

- Polygon/compound-outline markers — vanilla marker set doesn't have these. Options: approximate with dot-circle markers, or add custom `SCR_MapMarkerBase` subclasses (and if so, those live in TS Mission Toolkit as shared vocabulary, not in the planner mod).
- Hot-edit / live resync — auto-poll the backend every N seconds vs. require re-running the command. Manual is safer, polling is fancier. Defer.
- Multi-terrain support — v1 is Everon only. Generalizing means plan payload carries a terrain ID and the web tool loads the matching tileset.
- Who creates the short code — client-picked (conflict risk) vs. server-issued on POST (preferred).

## Next Steps

1. **Scaffold the new mod project** in Workbench. Naming: suggest `TS_OpsPlanner` to match toolkit prefix convention. Add dependency on TS Mission Toolkit.
2. **Pick the backend stack.** Cloudflare Workers + KV is cheapest & simplest for a keyed blob store; Supabase if you want a dashboard/auth later. Decide before writing the web tool.
3. **Define the JSON plan schema.** Two fields minimum: `markers[]` with `{ type: int, worldX: int, worldY: int, text: string, factionFlags: int }`. Version field (`schemaVersion: 1`) for future migrations.
4. **Write the Enforce Script JsonApiStruct classes** matching the schema. `TS_OpsPlanDTO` with nested `TS_OpsPlanMarkerDTO`. Register each field with `RegV()`.
5. **Write the in-game sync component.** Attaches to GameMode. Exposes a method that takes a plan code, calls `GetGame().GetRestApi().GetContext(...)`, GETs the plan, parses via JsonApiStruct, iterates markers calling `SCR_MapMarkerManagerComponent.GetInstance().InsertStaticMarkerByType(...)`. Tag each inserted marker so clear-and-replace can identify them later.
6. **Admin gate + UI.** Chat command or a simple dialog. Restrict to admin / GameMaster role. Don't let arbitrary players overwrite the plan mid-op.
7. **Web tool (separate repo).** Leaflet + CRS.Simple + Everon satellite tiles. Marker palette = `SCR_EMapMarkerType` enum values. Export: POST to backend, show short code.
8. **Test on dedicated server** — remember the prefab-override pattern from the toolkit CLAUDE.md; layer-level property overrides don't replicate to clients on DS. Not expected to matter for this mod since markers are spawned at runtime via the manager, but worth keeping in mind.

## Continuation Prompt
To continue, paste:
---
continue from & 'C:\Users\djdav\Obsidian Vaults\Alex''s Vault\Inbox\Project Kick-off.md'
---
