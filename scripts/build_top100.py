#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.edge_source import fetch_latest_edge_odds, parse_edge_payload
from src.model import ET, calculate_form_open_pool, rank_form_scores
from src.sources import HttpClient, game_log, season_hitter_pool
from src.storage import write_json
from src.top100_view import attach_market_data


def local_edge_odds(slate_date: date) -> dict | None:
    path = ROOT / "data" / "shared-odds" / "latest.json"
    if not path.exists() or path.stat().st_size == 0:
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if str(payload.get("date") or "") != slate_date.isoformat():
        return None
    edge = parse_edge_payload(
        payload,
        slate_date,
        enforce_checkpoint_age=False,
        require_confirmed_lineup=False,
    )
    edge["source_url"] = str(path.relative_to(ROOT))
    edge["compatibility_fallback"] = "local_shared_mirror"
    return edge


def optional_edge_odds(client: HttpClient, slate_date: date) -> tuple[dict | None, str | None]:
    try:
        local = local_edge_odds(slate_date)
        if local is not None:
            return local, None
    except Exception as exc:
        local_error = f"Local shared odds unavailable: {exc}"
    else:
        local_error = None

    try:
        return fetch_latest_edge_odds(client), local_error
    except Exception as exc:
        message = f"Optional MLB HR Edge odds unavailable: {exc}"
        if local_error:
            message = f"{local_error}; {message}"
        return None, message


def refresh_existing_odds(client: HttpClient, slate_date: date, now: datetime) -> bool:
    path = ROOT / "data" / "top100.json"
    if not path.exists() or path.stat().st_size == 0:
        return False
    output = json.loads(path.read_text(encoding="utf-8"))
    players = output.get("players")
    if output.get("slate_date") != slate_date.isoformat() or not isinstance(players, list):
        return False

    diagnostics = [
        str(item)
        for item in (output.get("diagnostics") or [])
        if not str(item).startswith("Optional MLB HR Edge odds unavailable:")
        and not str(item).startswith("Local shared odds unavailable:")
    ]
    edge, error = optional_edge_odds(client, slate_date)
    if error:
        diagnostics.append(error)
    output["odds"] = attach_market_data(players, edge, slate_date)
    output["generated_at"] = now.isoformat()
    output["generated_at_et"] = now.astimezone(ET).isoformat()
    output["odds_refreshed_at"] = now.isoformat()
    output["diagnostics"] = diagnostics
    write_json(path, output)
    print(
        f"Top 100 odds refreshed without rescoring: players={len(players)} "
        f"priced={output['odds']['priced_players']}"
    )
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="Slate date YYYY-MM-DD; defaults to current ET date")
    parser.add_argument(
        "--odds-only",
        action="store_true",
        help="Reuse today's rankings and refresh only local shared odds.",
    )
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    slate_date = date.fromisoformat(args.date) if args.date else now.astimezone(ET).date()
    client = HttpClient()

    if args.odds_only and refresh_existing_odds(client, slate_date, now):
        return 0

    output = {
        "schema_version": 2,
        "kind": "top_100_form_scores",
        "slate_date": slate_date.isoformat(),
        "generated_at": now.isoformat(),
        "generated_at_et": now.astimezone(ET).isoformat(),
        "status": "collecting",
        "method": "0.50*(HR games L5/5) + 0.30*(HR games L7/7) + 0.20*(HR games L15/15)",
        "eligibility": "Every MLB hitter with a current-season batting appearance and at least one prior PA-game containing a home run; no lineup or odds requirement.",
        "short_history_policy": "Fixed 5/7/15 denominators. Missing pre-debut games contribute zero. Fewer than 15 prior PA-games is labeled provisional.",
        "odds_policy": "Odds are optional display data from MLB HR Edge and never affect form ranking or eligibility.",
        "player_pool_count": 0,
        "scored_player_count": 0,
        "players": [],
        "odds": {
            "source": "MLB HR Edge",
            "status": "unavailable",
            "priced_players": 0,
            "coverage": None,
        },
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
    published = ranked[:100]
    for rank, row in enumerate(published, 1):
        row["rank"] = rank
        row["sample_status"] = "Provisional" if row["provisional"] else "Established"

    edge, error = optional_edge_odds(client, slate_date)
    if error:
        output["diagnostics"].append(error)

    output["odds"] = attach_market_data(published, edge, slate_date)
    output["scored_player_count"] = len(ranked)
    output["players"] = published
    output["status"] = "ready" if ranked else "no_players_in_form"
    if failures:
        output["diagnostics"].append(f"Game logs failed for {failures} players")

    write_json(ROOT / "data" / "top100.json", output)
    print(
        f"Top 100 built: pool={len(pool)} scored={len(ranked)} "
        f"published={len(output['players'])} priced={output['odds']['priced_players']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
