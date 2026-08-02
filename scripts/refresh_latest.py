#!/usr/bin/env python3
from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.edge_source import fetch_latest_edge_odds
from src.model import ET, calculate_form, choose_best_price, game_has_started, portfolio_summary, rank_candidates
from src.sources import HttpClient, game_log, schedule
from src.storage import rebuild, write_json


def games_by_pk(rows: dict[int, dict]) -> dict[int, dict]:
    return {
        int(game["gamePk"]): game
        for game in rows.values()
        if game.get("gamePk") is not None
    }


def main() -> int:
    now = datetime.now(timezone.utc)
    client = HttpClient()
    data_dir = ROOT / "data"

    latest = {
        "schema_version": 1,
        "kind": "latest_shared_slate",
        "refreshed_at": now.isoformat(),
        "refreshed_at_et": now.astimezone(ET).isoformat(),
        "status": "collecting",
        "sources": {},
        "diagnostics": [],
        "portfolios": {},
    }

    try:
        market = fetch_latest_edge_odds(client)
        latest["sources"]["mlb_hr_edge"] = {
            key: value for key, value in market.items() if key != "players"
        }
    except Exception as exc:
        latest["status"] = "shared_odds_source_unavailable"
        latest["diagnostics"].append(str(exc))
        write_json(data_dir / "latest.json", latest)
        rebuild(data_dir, ROOT)
        return 0

    slate_date = date.fromisoformat(market["source_date"])
    latest["slate_date"] = slate_date.isoformat()
    latest["source_generated_at"] = market.get("generated_at")

    if not market["players"]:
        latest["status"] = "shared_odds_slate_empty"
        write_json(data_dir / "latest.json", latest)
        rebuild(data_dir, ROOT)
        return 0

    try:
        games = games_by_pk(schedule(client, slate_date))
    except Exception as exc:
        games = {}
        latest["diagnostics"].append(f"MLB schedule unavailable: {exc}")

    logs: dict[int, list[dict] | Exception] = {}

    def fetch_log(row: dict) -> tuple[int, list[dict]]:
        player_id = int(row["batter_id"])
        return player_id, game_log(client, player_id, slate_date.year)

    with ThreadPoolExecutor(max_workers=18) as executor:
        futures = {executor.submit(fetch_log, row): row for row in market["players"]}
        for future in as_completed(futures):
            row = futures[future]
            player_id = int(row["batter_id"])
            try:
                _, player_games = future.result()
                logs[player_id] = player_games
            except Exception as exc:
                logs[player_id] = exc

    candidates: list[dict] = []
    for row in market["players"]:
        player_id = int(row["batter_id"])
        player_games = logs.get(player_id)
        if not isinstance(player_games, list):
            continue
        form = calculate_form(player_games, slate_date)
        if not form:
            continue

        game_pk = int(row.get("game_pk") or 0) or None
        game = games.get(game_pk or 0)
        if not game and row.get("game_start_at"):
            game = {
                "gamePk": game_pk,
                "gameDate": row.get("game_start_at"),
                "abstractState": "Preview",
            }
        if game_has_started(game, now):
            continue

        prices = list(row["prices"])
        best = choose_best_price(prices)
        if not best or int(best["odds"]) < 500:
            continue

        draftkings = next((p for p in prices if p.get("book_id") == "draftkings"), None)
        start_raw = row.get("game_start_at") or (game or {}).get("gameDate")
        game_time_et = None
        if start_raw:
            game_time_et = (
                datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
                .astimezone(ET)
                .strftime("%-I:%M %p ET")
            )

        candidates.append({
            "player": row["name"],
            "mlbam_id": player_id,
            "slate_date": slate_date.isoformat(),
            **form,
            "best_odds": int(best["odds"]),
            "best_sportsbook": best["book"],
            "best_price_verified": True,
            "best_price_captured_at": best.get("captured_at"),
            "best_source_event_id": best.get("source_event_id"),
            "best_source_odd_id": best.get("source_odd_id"),
            "all_prices": prices,
            "dk_odds": int(draftkings["odds"]) if draftkings else None,
            "game_pk": game_pk,
            "game_time_utc": start_raw,
            "game_time_et": game_time_et,
            "opponent": row.get("matchup"),
            "batter_team": row.get("batter_team"),
            "lineup_position": row.get("lineup_position"),
            "source_prediction_id": row.get("prediction_id"),
            "settled": False,
            "result": "LIVE",
            "home_runs": None,
            "profit_units": None,
        })

    ranked = rank_candidates(candidates)
    for rank, row in enumerate(ranked, 1):
        row["rank"] = rank

    def live_pick(row: dict) -> dict:
        return {
            "rank": row["rank"],
            "player": row["player"],
            "mlbam_id": row["mlbam_id"],
            "slate_date": row["slate_date"],
            "score": row["score"],
            "hr_games_l5": row["hr_games_l5"],
            "hr_games_l7": row["hr_games_l7"],
            "hr_games_l15": row["hr_games_l15"],
            "home_runs_l15": row["home_runs_l15"],
            "odds": row["best_odds"],
            "sportsbook": row["best_sportsbook"],
            "best_price_verified": True,
            "best_price_captured_at": row["best_price_captured_at"],
            "best_source_event_id": row["best_source_event_id"],
            "best_source_odd_id": row["best_source_odd_id"],
            "dk_odds": row["dk_odds"],
            "all_prices": row["all_prices"],
            "game_pk": row["game_pk"],
            "game_time_utc": row["game_time_utc"],
            "game_time_et": row["game_time_et"],
            "opponent": row["opponent"],
            "batter_team": row["batter_team"],
            "lineup_position": row["lineup_position"],
            "source_prediction_id": row["source_prediction_id"],
            "settled": False,
            "result": "LIVE",
            "profit_units": None,
        }

    for key, count in (("top10", 10), ("top20", 20)):
        picks = [live_pick(row) for row in ranked[:count]]
        latest["portfolios"][key] = {
            "picks": picks,
            "summary": portfolio_summary(picks),
        }

    latest["eligible_candidates"] = len(ranked)
    latest["status"] = "current" if ranked else "no_current_eligible_players"
    write_json(data_dir / "latest.json", latest)
    rebuild(data_dir, ROOT)
    print("latest", latest["slate_date"], latest["status"], len(ranked))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
