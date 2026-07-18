"""One-off: full per-player Russian stats report (no top-5 cap).

Reuses replay_stats' authoritative computation, renders every player in
each ranking, with Russian section labels. Numbers/names untouched.
"""

import sys
from collections import defaultdict

import replay_stats as rs

# UTF-8 stdout for Cyrillic + emoji on Windows.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def all_ranked(d):
    return [(k, v) for k, v in sorted(d.items(), key=lambda kv: -kv[1]) if v > 0]


def render_ru(stats_list, combined, codes):
    out = []
    multi = len(stats_list) > 1
    title = " + ".join(f"`{c}`" for c in codes)
    out.append(f"# Статистика операции — {title}")
    out.append("")
    if multi:
        out.append(f"Объединено по **{len(stats_list)}** реплеям (одна операция, разбитая перезапуском сервера).")
        out.append("")

    out.append("## Итоги операции")
    out.append(f"- ⏱ **Длительность**: {rs.fmt_duration(combined['duration_ms'])}")
    out.append(f"- 👥 **Игроков**: {len(combined['names'])}")
    out.append(f"- 🔫 **Выстрелов игроками**: {combined['total_shots_players']:,}")
    out.append(f"- 🤖 **Выстрелов ИИ**: {combined['total_shots_ai']:,}")
    out.append(f"- 💣 **Гранаты + подствольник (игроки)**: {sum(combined['grenades_by_name'].values()):,}")
    out.append(f"- 🚀 **Ракеты (игроки)**: {sum(combined['rockets_by_name'].values()):,}")
    out.append(f"- ☠️ **Погибло игроков**: {combined['total_player_deaths']}")
    out.append(f"- 🪖 **Уничтожено ИИ**: {combined['total_ai_deaths']}")
    player_ai_kills_total = sum(combined["ai_kills_by_name"].values())
    pvp_kills_total = sum(combined["pvp_kills_by_name"].values())
    out.append(f"- 🎯 **ИИ уничтожено игроками**: {player_ai_kills_total}")
    if pvp_kills_total:
        out.append(f"- ⚔️ **PvP-убийства игроками**: {pvp_kills_total}")
    out.append(f"- 🤝 **Случаев дружественного огня**: {len(combined['team_kills'])}")
    out.append(f"- 🛣 **Дистанция, пройденная игроками**: {rs.fmt_distance_m(combined['total_distance_m'])}")
    out.append("")
    if combined["names"]:
        out.append("**Состав**: " + ", ".join(f"`{n}`" for n in sorted(combined["names"])))
        out.append("")

    def block(label, d, fmt=lambda v: f"{v:,}"):
        ranked = all_ranked(d)
        if not ranked:
            return
        out.append(f"### {label}")
        for name, v in ranked:
            out.append(f"- `{name}` — {fmt(v)}")
        out.append("")

    out.append("## Рейтинги (все игроки)")
    out.append("")
    block("🎯 Убийства ИИ", combined["ai_kills_by_name"])
    block("🔫 Выстрелов", combined["shots_by_name"])
    block("💣 Гранаты + подствольник", combined["grenades_by_name"])
    block("🚀 Ракеты", combined["rockets_by_name"])
    block("☠️ Смертей", combined["deaths_by_name"])
    block("🩸 Раз нокаутирован", combined["incaps_by_name"])

    if combined["team_kills"]:
        out.append("### 🤝 Дружественный огонь")
        for killer_name, victim_name in combined["team_kills"]:
            if victim_name:
                out.append(f"- `{killer_name}` → `{victim_name}`")
            else:
                out.append(f"- `{killer_name}` → союзный ИИ")
        out.append("")

    # --- Achievements ---
    out.append("## Достижения")
    out.append("")
    ach = []
    if combined["first_shot_global"] is not None:
        _, n = combined["first_shot_global"]
        ach.append(f"- 🔫 **Первая кровь** — `{n}` (первый выстрел операции)")
    if combined["first_death_global"] is not None:
        _, n = combined["first_death_global"]
        ach.append(f"- ⚰️ **Первопроходец того света** — `{n}` (погиб первым)")
    ai_top = rs.top_n(combined["ai_kills_by_name"], 1)
    if ai_top:
        n, v = ai_top[0]
        ach.append(f"- 🎯 **Меткий стрелок** — `{n}` ({v} убийств ИИ)")
    g_top = rs.top_n(combined["grenades_by_name"], 1)
    if g_top:
        n, v = g_top[0]
        ach.append(f"- 💣 **Подрывник** — `{n}` ({v} гранат/подствольник)")
    r_top = rs.top_n(combined["rockets_by_name"], 1)
    if r_top:
        n, v = r_top[0]
        ach.append(f"- 🚀 **Ракетный хирург** — `{n}` ({v} ракет)")
    rev_top = rs.top_n(combined["revives_by_name"], 1)
    if rev_top:
        n, v = rev_top[0]
        ach.append(f"- 👻 **Возвращенец** — `{n}` ({v} подъёмов из нокаута)")

    best_gap = None
    best_name = None
    for name, times in combined["death_times_per_session"]:
        for i in range(1, len(times)):
            gap = times[i] - times[i - 1]
            if best_gap is None or gap < best_gap:
                best_gap = gap
                best_name = name
    if best_gap is not None and best_gap <= rs.QUICK_TURNAROUND_MAX_MS:
        gap_s = best_gap / 1000
        if gap_s < 60:
            gap_str = f"{gap_s:.1f}с"
        else:
            gap_str = f"{int(gap_s // 60)}м {int(gap_s % 60):02d}с"
        ach.append(f"- 💀 **Быстрое возвращение** — `{best_name}` (снова погиб через {gap_str} после прошлой смерти)")

    untouchable = sorted(
        n for n in combined["names"]
        if combined["shots_by_name"].get(n, 0) >= 10
        and combined["incaps_by_name"].get(n, 0) == 0
        and combined["deaths_by_name"].get(n, 0) == 0
    )
    if untouchable:
        ach.append(f"- 🛡️ **Неприкасаемые** ({len(untouchable)}): " + ", ".join(f"`{n}`" for n in untouchable))

    tk_counts = defaultdict(int)
    for killer_name, _ in combined["team_kills"]:
        tk_counts[killer_name] += 1
    tk_top = rs.top_n(tk_counts, 1)
    if tk_top:
        n, v = tk_top[0]
        ach.append(f"- 🤝 **Свой по своим** — `{n}` ({v} случаев дружественного огня)")

    diehard = {
        n: combined["incaps_by_name"].get(n, 0)
        for n in combined["names"]
        if combined["deaths_by_name"].get(n, 0) == 0
        and combined["incaps_by_name"].get(n, 0) >= 2
    }
    dh_top = rs.top_n(diehard, 1)
    if dh_top:
        n, v = dh_top[0]
        ach.append(f"- 🔁 **Крепкий орешек** — `{n}` ({v} нокаутов, 0 смертей)")

    if ach:
        out.extend(ach)
    else:
        out.append("_(Достижений в этой операции не открыто.)_")
    out.append("")

    if multi:
        out.append("---")
        out.append("**Длительность по реплеям**:")
        for s in stats_list:
            out.append(f"- `{s['code']}` — {rs.fmt_duration(s['duration_ms'])}")
        out.append("")

    return "\n".join(out)


def inject_labels(replay, labels):
    """Add synthetic player_join events for playerIds that possessed a
    character but never emitted a join (a TS Replay recorder bug — the name
    only ever arrives via player_join, so join-less players show up nameless
    on the map and get bucketed as AI in the stats). `labels` maps
    playerId -> name; we stamp each join at that pid's first possess time so
    the op's first_join_t / duration are unaffected."""
    events = replay["events"]
    first_poss = {}
    for e in events:
        if e["type"] == "possess" and e.get("charId", 0) != 0:
            first_poss.setdefault(e["playerId"], e["t"])
    for pid, name in labels.items():
        t = first_poss.get(pid, 0)
        events.append({"type": "player_join", "playerId": pid, "name": name, "t": t})


def main():
    # Parse args: codes plus optional
    #   --exclude Name1,Name2   fold a player (e.g. a Game Master) into AI
    #   --label PID=Name        name a join-less player (recorder dropped join)
    args = sys.argv[1:]
    excluded = []
    labels = {}
    codes = []
    i = 0
    while i < len(args):
        if args[i] == "--exclude":
            i += 1
            if i < len(args):
                excluded.extend(n.strip() for n in args[i].split(",") if n.strip())
        elif args[i] == "--label":
            i += 1
            if i < len(args) and "=" in args[i]:
                pid_s, name = args[i].split("=", 1)
                labels[int(pid_s.strip())] = name.strip()
        else:
            codes.append(args[i])
        i += 1
    # This community has a real human player named "bot" — don't treat the
    # name as a system/host entity. Whitelisting it puts their shots in the
    # player bucket and attributes their AI kills.
    rs.SYSTEM_PLAYER_NAMES = set()
    stats_list = []
    for c in codes:
        replay = rs.fetch_replay(c)
        if labels:
            inject_labels(replay, labels)
        stats_list.append(rs.compute_stats(replay, extra_excluded_names=excluded))
    combined = rs.combine(stats_list)
    print(render_ru(stats_list, combined, codes))


if __name__ == "__main__":
    main()
