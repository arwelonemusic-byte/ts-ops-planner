"""replay_stats.py — Community-postable Op stats from TS Replay codes.

Fetches one or more replays from the live ts-ops-planner-web API, computes
op-level + per-player + achievement stats, prints a Markdown report ready
to drop into Discord / forum.

Usage:
    py replay_stats.py CODE1 [CODE2 ...]

Multi-code: stats are combined across replays (players matched by name).
Useful when a server crash splits one operation into two recordings.
"""

import json
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from math import sqrt

# Force UTF-8 stdout so emoji in the report don't crash Windows cp1252.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_URL = "https://ts-ops-planner-web.vercel.app"
CHUNK_LIMIT = 20000

# Single-tick position jumps above this are treated as teleports (admin
# zaps players from spawn to action) and excluded from distance totals.
# A jet at 400 km/h covers ~111 m/s, so 200m/tick is a generous ceiling.
TELEPORT_M = 200

# Phantom char filter — same as the web side. Chars whose every move event
# sits within this radius of world origin are spawn-menu placeholders the
# engine attaches to dead players. Excluded from death counts and rankings.
PHANTOM_RADIUS_M = 5

# Player names treated as system entities (host bot, scenario AI controller).
# Excluded from rankings, roster, and achievement eligibility — but their
# shots still count toward the AI shot total.
SYSTEM_PLAYER_NAMES = {"bot"}

# "Quick Turnaround" is only interesting if the re-death happens fast.
# 5 minutes is the upper bound for "this player got pasted and ran straight
# back into trouble" — beyond that it's just normal op-flow respawning.
QUICK_TURNAROUND_MAX_MS = 5 * 60 * 1000


def fetch_replay(code):
    """Pull a full replay payload via chunked pagination. Returns the raw
    JSON dict with `events` already merged."""
    print(f"  fetching {code}...", file=sys.stderr)
    offset = 0
    all_events = []
    meta = None
    while True:
        url = f"{BASE_URL}/api/replays/{urllib.parse.quote(code)}?offset={offset}&limit={CHUNK_LIMIT}"
        with urllib.request.urlopen(url) as r:
            data = json.load(r)
        if meta is None:
            meta = {k: v for k, v in data.items() if k != "events"}
        events = data.get("events", [])
        all_events.extend(events)
        total = data.get("totalEvents", len(events))
        offset += len(events)
        if offset >= total or not events:
            break
    meta["events"] = all_events
    meta["code"] = code
    return meta


def detect_phantoms(events):
    """Phantom chars: at least one move, every move within PHANTOM_RADIUS_M
    of (0,0). These are spawn-menu placeholders, not real chars."""
    moves_by_char = defaultdict(list)
    for e in events:
        if e.get("type") == "move":
            moves_by_char[e["charId"]].append((e["x"], e["z"]))
    phantoms = set()
    for cid, pts in moves_by_char.items():
        if pts and all(abs(x) <= PHANTOM_RADIUS_M and abs(z) <= PHANTOM_RADIUS_M for x, z in pts):
            phantoms.add(cid)
    return phantoms


def truthy(v):
    """Recorder emits booleans as Enforcement-Script-friendly strings on
    some builds, raw booleans on others. Accept both."""
    return v is True or v == "true"


def compute_stats(replay, extra_excluded_names=None):
    """Compute per-replay stats. Returns a dict suitable for combining
    across multiple replays by player name.

    `extra_excluded_names` joins SYSTEM_PLAYER_NAMES at runtime — typically
    used to drop admin-puppeting accounts whose stats are mostly bot-play
    noise. Their activity folds into the AI bucket, same as `bot`.
    """
    events = replay["events"]
    phantoms = detect_phantoms(events)

    excluded = set(SYSTEM_PLAYER_NAMES) | set(extra_excluded_names or [])

    player_names = {}  # playerId -> name (system entities filtered)
    char_owner = {}    # charId -> playerId (latest possessor wins)
    for e in events:
        t = e["type"]
        if t == "player_join":
            if e["name"] in excluded:
                continue
            player_names[e["playerId"]] = e["name"]
        elif t == "possess" and e.get("charId", 0) != 0:
            char_owner[e["charId"]] = e["playerId"]

    first_join_t = min(
        (e["t"] for e in events if e["type"] == "player_join"),
        default=0,
    )

    # "Last out" = last event involving a player-controlled char. AI-only
    # tail activity after every player left doesn't count as op time.
    last_player_activity = first_join_t
    for e in events:
        owner_pid = None
        et = e["type"]
        if et == "shot":
            owner_pid = char_owner.get(e["shooterCharId"])
        elif et in ("move", "damage_state", "char_delete"):
            owner_pid = char_owner.get(e.get("charId"))
        if owner_pid is not None:
            if e["t"] > last_player_activity:
                last_player_activity = e["t"]

    duration_ms = max(0, last_player_activity - first_join_t)

    # --- Shots ---
    shots_by_player = defaultdict(int)
    grenades_by_player = defaultdict(int)  # frag + UGL (explosion, not heavy)
    rockets_by_player = defaultdict(int)   # heavy explosion
    total_shots_players = 0
    total_shots_ai = 0
    first_shot = None  # (t, playerId)

    for e in events:
        if e["type"] != "shot":
            continue
        shooter = e.get("shooterCharId")
        owner = char_owner.get(shooter)
        is_exp = truthy(e.get("isExplosion"))
        is_heavy = truthy(e.get("isHeavy"))
        if owner is not None and owner in player_names:
            total_shots_players += 1
            shots_by_player[owner] += 1
            if is_heavy:
                rockets_by_player[owner] += 1
            elif is_exp:
                grenades_by_player[owner] += 1
            if first_shot is None or e["t"] < first_shot[0]:
                first_shot = (e["t"], owner)
        else:
            total_shots_ai += 1

    # --- Deaths / incaps / revives (state transitions per char) ---
    damages_by_char = defaultdict(list)
    for e in events:
        if e["type"] == "damage_state":
            damages_by_char[e["charId"]].append((e["t"], e["state"]))

    deaths_by_player = defaultdict(int)
    incaps_by_player = defaultdict(int)
    revives_by_player = defaultdict(int)
    death_times_by_player = defaultdict(list)
    total_player_deaths = 0
    total_ai_deaths = 0
    first_death = None  # (t, playerId)

    for cid, states in damages_by_char.items():
        if cid in phantoms:
            continue
        states.sort()
        owner = char_owner.get(cid)
        is_player_char = owner is not None and owner in player_names
        prev = 0  # ALIVE before any event
        for t, s in states:
            if s == 2 and prev != 2:
                if is_player_char:
                    deaths_by_player[owner] += 1
                    death_times_by_player[owner].append(t)
                    if first_death is None or t < first_death[0]:
                        first_death = (t, owner)
                    total_player_deaths += 1
                else:
                    total_ai_deaths += 1
            elif s == 1 and prev != 1:
                if is_player_char:
                    incaps_by_player[owner] += 1
            elif s == 0 and prev == 1:
                if is_player_char:
                    revives_by_player[owner] += 1
            prev = s

    # --- Distance covered by players (teleport-filtered) ---
    moves_by_char_sorted = defaultdict(list)
    for e in events:
        if e["type"] == "move":
            moves_by_char_sorted[e["charId"]].append((e["t"], e["x"], e["z"]))

    total_distance_m = 0.0
    for cid, pts in moves_by_char_sorted.items():
        if cid in phantoms:
            continue
        owner = char_owner.get(cid)
        if owner is None or owner not in player_names:
            continue
        pts.sort()
        for i in range(1, len(pts)):
            dx = pts[i][1] - pts[i - 1][1]
            dz = pts[i][2] - pts[i - 1][2]
            d = sqrt(dx * dx + dz * dz)
            if d <= TELEPORT_M:
                total_distance_m += d

    # --- Joyrider: cumulative time inside any vehicle (per player) ---
    # Walk vehicle_occupants snapshots chronologically per vehicle.
    # When a charId appears that wasn't there last snapshot, open an
    # interval; when they vanish, close it. Last-known state is closed at
    # last_player_activity so vehicles still occupied at session end
    # contribute correctly.
    veh_events = sorted(
        (e for e in events if e["type"] == "vehicle_occupants"),
        key=lambda e: e["t"],
    )
    veh_state = {}  # vehicleId -> {charId: enter_t}
    veh_time_by_char = defaultdict(int)
    for e in veh_events:
        vid = e["vehicleId"]
        t = e["t"]
        new_set = set(e.get("charIds") or [])
        prev_state = veh_state.setdefault(vid, {})
        for cid, enter_t in list(prev_state.items()):
            if cid not in new_set:
                veh_time_by_char[cid] += t - enter_t
                del prev_state[cid]
        for cid in new_set:
            if cid not in prev_state:
                prev_state[cid] = t
    for vid, state in veh_state.items():
        for cid, enter_t in state.items():
            veh_time_by_char[cid] += max(0, last_player_activity - enter_t)

    joyride_by_player = defaultdict(int)
    for cid, ms in veh_time_by_char.items():
        owner = char_owner.get(cid)
        if owner is None or owner not in player_names:
            continue
        joyride_by_player[owner] += ms

    # --- Kills (mod-side `kill` events, killerCharId + killerPlayerId +
    # victimPlayerId + isTeamKill). Surfaces AI kills per player and team-
    # kill incidents. Player victims are already counted via damage_state
    # transitions above; the kill event adds the attribution layer.
    ai_kills_by_player = defaultdict(int)
    pvp_kills_by_player = defaultdict(int)  # legitimate enemy player kills (PvP scenarios)
    team_kills = []  # list of (t, killer_name, victim_name_or_None)
    for e in events:
        if e["type"] != "kill":
            continue
        killer_pid = e.get("killerPlayerId", 0)
        victim_pid = e.get("victimPlayerId", 0)
        if killer_pid <= 0 or killer_pid not in player_names:
            continue  # AI killer — already in total_ai_deaths bucket
        killer_name = player_names[killer_pid]
        # Team kills: only surface those committed by a named player. The
        # mod's faction-compare flags AI-on-friendly-AI too (engine noise);
        # those land in this branch via killer_pid > 0 only if a player did
        # the deed, which is the actionable subset.
        if e.get("isTeamKill"):
            victim_name = player_names.get(victim_pid) if victim_pid > 0 else None
            team_kills.append((e["t"], killer_name, victim_name))
            continue
        if victim_pid > 0 and victim_pid in player_names:
            pvp_kills_by_player[killer_name] += 1
        else:
            ai_kills_by_player[killer_name] += 1

    return {
        "code": replay.get("code"),
        "first_join_t": first_join_t,
        "last_t": last_player_activity,
        "duration_ms": duration_ms,
        "player_names": dict(player_names),
        "total_shots_players": total_shots_players,
        "total_shots_ai": total_shots_ai,
        "total_player_deaths": total_player_deaths,
        "total_ai_deaths": total_ai_deaths,
        "total_distance_m": total_distance_m,
        "shots_by_player": dict(shots_by_player),
        "grenades_by_player": dict(grenades_by_player),
        "rockets_by_player": dict(rockets_by_player),
        "deaths_by_player": dict(deaths_by_player),
        "incaps_by_player": dict(incaps_by_player),
        "revives_by_player": dict(revives_by_player),
        "death_times_by_player": dict(death_times_by_player),
        "joyride_by_player": dict(joyride_by_player),
        "ai_kills_by_player": dict(ai_kills_by_player),
        "pvp_kills_by_player": dict(pvp_kills_by_player),
        "team_kills": team_kills,
        "first_shot": first_shot,
        "first_death": first_death,
    }


def combine(stats_list):
    """Aggregate per-replay stats by player name. Names match across
    replays — that's the whole point of multi-code support."""
    names = set()
    for s in stats_list:
        names.update(s["player_names"].values())

    out = {
        "duration_ms": sum(s["duration_ms"] for s in stats_list),
        "total_shots_players": sum(s["total_shots_players"] for s in stats_list),
        "total_shots_ai": sum(s["total_shots_ai"] for s in stats_list),
        "total_player_deaths": sum(s["total_player_deaths"] for s in stats_list),
        "total_ai_deaths": sum(s["total_ai_deaths"] for s in stats_list),
        "total_distance_m": sum(s["total_distance_m"] for s in stats_list),
        "shots_by_name": defaultdict(int),
        "grenades_by_name": defaultdict(int),
        "rockets_by_name": defaultdict(int),
        "deaths_by_name": defaultdict(int),
        "incaps_by_name": defaultdict(int),
        "revives_by_name": defaultdict(int),
        "joyride_by_name": defaultdict(int),
        "ai_kills_by_name": defaultdict(int),
        "pvp_kills_by_name": defaultdict(int),
        "team_kills": [],  # list of (killer_name, victim_name_or_None) across all replays
        # Per-replay death-time lists for the "Quick Turnaround" achievement.
        # Multi-replay: gaps only count within a single replay (a player
        # who died at the end of replay 1 and at the start of replay 2 is
        # really a "respawned after a server crash", not a fast re-death).
        "death_times_per_session": [],  # list of (name, [t...])
        "names": names,
        "first_shot_global": None,    # (t, name)
        "first_death_global": None,   # (t, name)
    }

    for s in stats_list:
        for pid, v in s["shots_by_player"].items():
            n = s["player_names"].get(pid)
            if n:
                out["shots_by_name"][n] += v
        for pid, v in s["grenades_by_player"].items():
            n = s["player_names"].get(pid)
            if n:
                out["grenades_by_name"][n] += v
        for pid, v in s["rockets_by_player"].items():
            n = s["player_names"].get(pid)
            if n:
                out["rockets_by_name"][n] += v
        for pid, v in s["deaths_by_player"].items():
            n = s["player_names"].get(pid)
            if n:
                out["deaths_by_name"][n] += v
        for pid, v in s["incaps_by_player"].items():
            n = s["player_names"].get(pid)
            if n:
                out["incaps_by_name"][n] += v
        for pid, v in s["revives_by_player"].items():
            n = s["player_names"].get(pid)
            if n:
                out["revives_by_name"][n] += v
        for pid, v in s["joyride_by_player"].items():
            n = s["player_names"].get(pid)
            if n:
                out["joyride_by_name"][n] += v
        for name, v in s["ai_kills_by_player"].items():
            out["ai_kills_by_name"][name] += v
        for name, v in s["pvp_kills_by_player"].items():
            out["pvp_kills_by_name"][name] += v
        for _t, killer_name, victim_name in s["team_kills"]:
            out["team_kills"].append((killer_name, victim_name))
        for pid, times in s["death_times_by_player"].items():
            n = s["player_names"].get(pid)
            if n and times:
                out["death_times_per_session"].append((n, sorted(times)))
        if s["first_shot"] is not None:
            t, pid = s["first_shot"]
            n = s["player_names"].get(pid)
            if n and (out["first_shot_global"] is None or t < out["first_shot_global"][0]):
                out["first_shot_global"] = (t, n)
        if s["first_death"] is not None:
            t, pid = s["first_death"]
            n = s["player_names"].get(pid)
            if n and (out["first_death_global"] is None or t < out["first_death_global"][0]):
                out["first_death_global"] = (t, n)
    return out


def fmt_duration(ms):
    s = ms // 1000
    h = s // 3600
    m = (s % 3600) // 60
    sec = s % 60
    if h:
        return f"{h}h {m:02d}m {sec:02d}s"
    return f"{m}m {sec:02d}s"


def fmt_distance_m(m):
    if m >= 1000:
        return f"{m / 1000:.1f} km"
    return f"{int(m)} m"


def fmt_time_ms(ms):
    s = ms // 1000
    m = s // 60
    return f"{m}m {s % 60:02d}s"


def top_n(d, n=5):
    return [(k, v) for k, v in sorted(d.items(), key=lambda kv: -kv[1])[:n] if v > 0]


def render_markdown(stats_list, combined, codes):
    out = []
    multi = len(stats_list) > 1

    title = " + ".join(f"`{c}`" for c in codes)
    out.append(f"# Op Stats — {title}")
    out.append("")
    if multi:
        out.append(f"Combined across **{len(stats_list)}** replays (one operation, split by server restart).")
        out.append("")

    # --- Global totals ---
    out.append("## Op Totals")
    out.append(f"- ⏱ **Duration**: {fmt_duration(combined['duration_ms'])}")
    out.append(f"- 👥 **Players**: {len(combined['names'])}")
    out.append(f"- 🔫 **Shots fired by players**: {combined['total_shots_players']:,}")
    out.append(f"- 🤖 **Shots fired by AI**: {combined['total_shots_ai']:,}")
    out.append(f"- 💣 **Grenades + UGL by players**: {sum(combined['grenades_by_name'].values()):,}")
    out.append(f"- 🚀 **Rockets by players**: {sum(combined['rockets_by_name'].values()):,}")
    out.append(f"- ☠️ **Player KIA**: {combined['total_player_deaths']}")
    out.append(f"- 🪖 **AI eliminated**: {combined['total_ai_deaths']}")
    player_ai_kills_total = sum(combined["ai_kills_by_name"].values())
    pvp_kills_total = sum(combined["pvp_kills_by_name"].values())
    out.append(f"- 🎯 **AI eliminated by players**: {player_ai_kills_total}")
    if pvp_kills_total:
        out.append(f"- ⚔️ **PvP kills by players**: {pvp_kills_total}")
    out.append(f"- 🤝 **Friendly fire incidents**: {len(combined['team_kills'])}")
    out.append(f"- 🛣 **Distance covered by players**: {fmt_distance_m(combined['total_distance_m'])}")
    out.append("")
    if combined["names"]:
        out.append("**Roster**: " + ", ".join(f"`{n}`" for n in sorted(combined["names"])))
        out.append("")

    # --- Rankings ---
    def block(label, d, fmt=lambda v: f"{v:,}", n=5):
        ranked = top_n(d, n)
        if not ranked:
            return
        out.append(f"### {label}")
        for name, v in ranked:
            out.append(f"- `{name}` — {fmt(v)}")
        out.append("")

    out.append("## Rankings (top 5)")
    out.append("")
    # Kills get a deeper top-10 because the kill stat is the new headline
    # number and a 10-deep list rewards consistent contributors, not just
    # the top of the squad.
    block("🎯 AI Kills", combined["ai_kills_by_name"], n=10)
    block("🔫 Shots Fired", combined["shots_by_name"])
    block("💣 Grenades + UGL", combined["grenades_by_name"])
    block("🚀 Rockets", combined["rockets_by_name"])
    block("☠️ Deaths", combined["deaths_by_name"])
    block("🩸 Times Incapacitated", combined["incaps_by_name"])

    # Friendly fire roll — surfaced as a flat list because the count is
    # usually small and individual incidents matter more than a ranking.
    if combined["team_kills"]:
        out.append("### 🤝 Friendly Fire")
        for killer_name, victim_name in combined["team_kills"]:
            if victim_name:
                out.append(f"- `{killer_name}` → `{victim_name}`")
            else:
                out.append(f"- `{killer_name}` → AI teammate")
        out.append("")

    # --- Achievements ---
    out.append("## Achievements")
    out.append("")
    achievements = []

    if combined["first_shot_global"] is not None:
        _, n = combined["first_shot_global"]
        achievements.append(f"- 🔫 **First Blood** — `{n}` (first shot of the op)")

    if combined["first_death_global"] is not None:
        _, n = combined["first_death_global"]
        achievements.append(f"- ⚰️ **Pioneer of the Afterlife** — `{n}` (first to die)")

    ai_top = top_n(combined["ai_kills_by_name"], 1)
    if ai_top:
        n, v = ai_top[0]
        achievements.append(f"- 🎯 **Sharpshooter** — `{n}` ({v} AI kills)")

    g_top = top_n(combined["grenades_by_name"], 1)
    if g_top:
        n, v = g_top[0]
        achievements.append(f"- 💣 **Demolitionist** — `{n}` ({v} grenades/UGL)")

    r_top = top_n(combined["rockets_by_name"], 1)
    if r_top:
        n, v = r_top[0]
        achievements.append(f"- 🚀 **Rocket Surgeon** — `{n}` ({v} rockets)")

    rev_top = top_n(combined["revives_by_name"], 1)
    if rev_top:
        n, v = rev_top[0]
        achievements.append(f"- 👻 **Comeback Kid** — `{n}` ({v} revives from incap)")

    # Quick Turnaround — shortest gap between two consecutive deaths.
    # Computed within a single replay only; cross-replay gaps would be
    # post-crash respawns, not real fast re-deaths.
    best_gap = None
    best_name = None
    for name, times in combined["death_times_per_session"]:
        for i in range(1, len(times)):
            gap = times[i] - times[i - 1]
            if best_gap is None or gap < best_gap:
                best_gap = gap
                best_name = name
    if best_gap is not None and best_gap <= QUICK_TURNAROUND_MAX_MS:
        gap_s = best_gap / 1000
        if gap_s < 60:
            gap_str = f"{gap_s:.1f}s"
        else:
            gap_str = f"{int(gap_s // 60)}m {int(gap_s % 60):02d}s"
        achievements.append(
            f"- 💀 **Quick Turnaround** — `{best_name}` (re-died {gap_str} after previous death)"
        )

    # Untouchable — fired ≥10 shots, never incapped, never died.
    untouchable = sorted(
        n for n in combined["names"]
        if combined["shots_by_name"].get(n, 0) >= 10
        and combined["incaps_by_name"].get(n, 0) == 0
        and combined["deaths_by_name"].get(n, 0) == 0
    )
    if untouchable:
        achievements.append(
            f"- 🛡️ **Untouchable** ({len(untouchable)}): "
            + ", ".join(f"`{n}`" for n in untouchable)
        )

    # Blue on Blue — most TKs committed by a single player. Only fires when
    # someone actually TK'd; we don't roast people on a hypothetical.
    tk_counts = defaultdict(int)
    for killer_name, _ in combined["team_kills"]:
        tk_counts[killer_name] += 1
    tk_top = top_n(tk_counts, 1)
    if tk_top:
        n, v = tk_top[0]
        word = "incident" if v == 1 else "incidents"
        achievements.append(f"- 🤝 **Blue on Blue** — `{n}` ({v} friendly fire {word})")

    # Die Hard — most incaps among players with zero deaths (and ≥2 incaps,
    # otherwise it's just "got hit once and pulled through").
    diehard_candidates = {
        n: combined["incaps_by_name"].get(n, 0)
        for n in combined["names"]
        if combined["deaths_by_name"].get(n, 0) == 0
        and combined["incaps_by_name"].get(n, 0) >= 2
    }
    dh_top = top_n(diehard_candidates, 1)
    if dh_top:
        n, v = dh_top[0]
        achievements.append(f"- 🔁 **Die Hard** — `{n}` ({v} incaps, 0 deaths)")

    if achievements:
        out.extend(achievements)
    else:
        out.append("_(No achievements unlocked this op.)_")
    out.append("")

    if multi:
        out.append("---")
        out.append("**Per-replay duration breakdown**:")
        for s in stats_list:
            out.append(f"- `{s['code']}` — {fmt_duration(s['duration_ms'])}")
        out.append("")

    return "\n".join(out)


def main():
    args = sys.argv[1:]
    excluded = []
    codes = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--exclude":
            i += 1
            if i >= len(args):
                print("--exclude needs a comma-separated name list", file=sys.stderr)
                sys.exit(1)
            excluded.extend(n.strip() for n in args[i].split(",") if n.strip())
        else:
            codes.append(a)
        i += 1
    if not codes:
        print("Usage: py replay_stats.py [--exclude Name1,Name2] CODE1 [CODE2 ...]", file=sys.stderr)
        sys.exit(1)
    stats_list = [compute_stats(fetch_replay(code), extra_excluded_names=excluded) for code in codes]
    combined = combine(stats_list)
    print(render_markdown(stats_list, combined, codes))


if __name__ == "__main__":
    main()
