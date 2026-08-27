from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from typing import Any

from src.model import ET, calculate_form_open_pool, rank_form_scores
from src.sources import HttpClient, game_log, season_hitter_pool


def build_top100_payload(
    slate_date: date,
    *,
    now: datetime | None = None,
    max_workers: int = 24,
) -> dict[str, Any]:
    """Build the odds-independent HR Top 100 without touching the filesystem.

    This is the serverless equivalent of the HR portion of scripts/build_top100.py.
    It intentionally uses the same MLB sources and locked score implementation.
    """
    now = now or datetime.now(timezone.utc)
    output: dict[str, Any] = {
        "schema_version": 3,
        "kind": "top_100_form_scores",
        "slate_date": slate_date.isoformat(),
        "generated_at": now.isoformat(),
        "generated_at_et": now.astimezone(ET).isoformat(),
        "status": "collecting",
        "delivery": "qstash-vercel-redis",
        "method": "0.50*(HR games L5/5) + 0.30*(HR games L7/7) + 0.20*(HR games L15/15)",
        "eligibility": "Every MLB hitter with a current-season batting appearance and at least one prior PA-game containing a home run; no lineup or odds requirement.",
        "short_history_policy": "Fixed 5/7/15 denominators. Missing pre-debut games contribute zero. Fewer than 15 prior PA-games is labeled provisional.",
        "odds_policy": "Odds are joined from immutable Redis checkpoints for Discovery and never affect form ranking or eligibility.",
        "player_pool_count": 0,
        "scored_player_count": 0,
        "players": [],
        "odds": {
            "source": "MLB HR Edge checkpoint database",
            "status": "separate_checkpoint_join",
            "priced_players": 0,
            "coverage": None,
        },
        "diagnostics": [],
    }

    client = HttpClient()
    try:
        pool = season_hitter_pool(client, slate_date.year)
    except Exception as exc:
        output["status"] = "player_pool_unavailable"
        output["diagnostics"].append(str(exc))
        return output

    output["player_pool_count"] = len(pool)
    logs: dict[int, list[dict] | Exception] = {}

    def fetch(row: dict) -> tuple[int, list[dict]]:
        player_id = int(row["mlbam_id"])
        return player_id, game_log(client, player_id, slate_date.year)

    workers = max(1, min(int(max_workers), 32))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(fetch, row): row for row in pool}
        for future in as_completed(futures):
            row = futures[future]
            player_id = int(row["mlbam_id"])
            try:
                _, player_games = future.result()
                logs[player_id] = player_games
            except Exception as exc:
                logs[player_id] = exc

    rows: list[dict[str, Any]] = []
    failures = 0
    for player in pool:
        player_id = int(player["mlbam_id"])
        player_games = logs.get(player_id)
        if not isinstance(player_games, list):
            failures += 1
            continue
        form = calculate_form_open_pool(player_games, slate_date)
        if not form:
            continue
        rows.append(
            {
                "player": player["player"],
                "mlbam_id": player_id,
                "team": player.get("team"),
                "team_id": player.get("team_id"),
                "season_plate_appearances": player.get("season_plate_appearances"),
                **form,
            }
        )

    ranked = rank_form_scores(rows)
    published = ranked[:100]
    for rank, row in enumerate(published, 1):
        row["rank"] = rank
        row["sample_status"] = "Provisional" if row["provisional"] else "Established"

    output["scored_player_count"] = len(ranked)
    output["players"] = published
    output["status"] = "ready" if ranked else "no_players_in_form"
    if failures:
        output["diagnostics"].append(f"Game logs failed for {failures} players")
    return output
