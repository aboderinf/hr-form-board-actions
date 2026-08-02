#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.model import ET, calculate_form_open_pool, rank_form_scores
from src.sources import HttpClient, game_log, season_hitter_pool
from src.storage import write_json


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="Slate date YYYY-MM-DD; defaults to current ET date")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    slate_date = date.fromisoformat(args.date) if args.date else now.astimezone(ET).date()
    client = HttpClient()

    output = {
        "schema_version": 1,
        "kind": "top_100_form_scores",
        "slate_date": slate_date.isoformat(),
        "generated_at": now.isoformat(),
        "generated_at_et": now.astimezone(ET).isoformat(),
        "status": "collecting",
        "method": "0.50*(HR games L5/5) + 0.30*(HR games L7/7) + 0.20*(HR games L15/15)",
        "eligibility": "Every MLB hitter with a current-season batting appearance and at least one prior PA-game containing a home run; no lineup or odds requirement.",
        "short_history_policy": "Fixed 5/7/15 denominators. Missing pre-debut games contribute zero. Fewer than 15 prior PA-games is labeled provisional.",
        "player_pool_count": 0,
        "scored_player_count": 0,
        "players": [],
        "diagnostics": [],
    }

    try:
        pool = season_hitter_pool(client, slate_date.year)
    except Exception as exc:
        output["status"] = "player_pool_unavailable"
        output["diagnostics"].append(str(exc))
        write_json(ROOT / "data" / "top100.json", output)
        return 0

    output["player_pool_count"] = len(pool)
    logs: dict[int, list[dict] | Exception] = {}

    def fetch(row: dict) -> tuple[int, list[dict]]:
        player_id = int(row["mlbam_id"])
        return player_id, game_log(client, player_id, slate_date.year)

    with ThreadPoolExecutor(max_workers=24) as executor:
        futures = {executor.submit(fetch, row): row for row in pool}
        for future in as_completed(futures):
            row = futures[future]
            player_id = int(row["mlbam_id"])
            try:
                _, player_games = future.result()
                logs[player_id] = player_games
            except Exception as exc:
                logs[player_id] = exc

    rows: list[dict] = []
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
    for rank, row in enumerate(ranked[:100], 1):
        row["rank"] = rank
        row["sample_status"] = "Provisional" if row["provisional"] else "Established"
        row.pop("recent_games", None)

    output["scored_player_count"] = len(ranked)
    output["players"] = ranked[:100]
    output["status"] = "ready" if ranked else "no_players_in_form"
    if failures:
        output["diagnostics"].append(f"Game logs failed for {failures} players")

    write_json(ROOT / "data" / "top100.json", output)
    print(
        f"Top 100 built: pool={len(pool)} scored={len(ranked)} "
        f"published={len(output['players'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
