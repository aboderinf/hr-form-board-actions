#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.edge_source import fetch_edge_odds
from src.model import (
    CHECKPOINTS,
    ET,
    calculate_form,
    choose_best_price,
    choose_checkpoint,
    explicit_checkpoint,
    game_has_started,
    portfolio_summary,
    rank_candidates,
    settle_pick,
)
from src.sources import HttpClient, game_log, schedule
from src.storage import load_json, rebuild, write_json


def games_by_pk(schedule_rows: dict[int, dict]) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for game in schedule_rows.values():
        game_pk = game.get("gamePk")
        if game_pk is not None:
            out[int(game_pk)] = game
    return out


def settle_old(client: HttpClient, files: list[Path], now: datetime) -> None:
    for path in files:
        snapshot = load_json(path, {})
        day = snapshot.get("slate_date")
        if not day:
            continue

        changed = False
        logs: dict[int, list[dict]] = {}
        try:
            day_schedule = schedule(client, date.fromisoformat(day))
            games = games_by_pk(day_schedule)
        except Exception:
            games = {}

        for portfolio_key in ("top10", "top20"):
            portfolio = (snapshot.get("portfolios") or {}).get(portfolio_key) or {}
            picks = portfolio.get("picks") or []
            for pick in picks:
                if pick.get("settled") or not pick.get("mlbam_id"):
                    continue
                player_id = int(pick["mlbam_id"])
                try:
                    if player_id not in logs:
                        logs[player_id] = game_log(client, player_id, int(day[:4]))
                except Exception as exc:
                    pick["settlement_error"] = str(exc)
                    continue

                game = games.get(int(pick.get("game_pk") or 0))
                result = settle_pick(pick, logs[player_id], game)
                if result["settled"]:
                    pick.update(result)
                    pick["settled_at"] = now.isoformat()
                    changed = True

            if picks:
                portfolio["summary"] = portfolio_summary(picks)

        if changed:
            write_json(path, snapshot)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date")
    parser.add_argument("--checkpoint", choices=CHECKPOINTS)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    checkpoint = (
        explicit_checkpoint(args.date, args.checkpoint)
        if args.date and args.checkpoint
        else choose_checkpoint(now)
    )
    if not checkpoint:
        print("No ET checkpoint due")
        return 0

    data_dir = ROOT / "data"
    snapshot_dir = data_dir / "snapshots"
    snapshot_path = snapshot_dir / f"{checkpoint.snapshot_id}.json"
    client = HttpClient()

    settle_old(client, sorted(snapshot_dir.glob("*.json")), now)
    if snapshot_path.exists() and not args.force:
        rebuild(data_dir, ROOT)
        print("Snapshot exists; settlement only")
        return 0

    snapshot = {
        "schema_version": 2,
        "snapshot_id": checkpoint.snapshot_id,
        "slate_date": checkpoint.slate_date.isoformat(),
        "checkpoint_et": checkpoint.label,
        "scheduled_at_et": checkpoint.scheduled_at.isoformat(),
        "observed_at": now.isoformat(),
        "observed_at_et": now.astimezone(ET).isoformat(),
        "status": "collecting",
        "sources": {},
        "diagnostics": [],
        "portfolios": {},
    }

    try:
        market = fetch_edge_odds(
            client,
            checkpoint.slate_date,
            checkpoint.scheduled_at,
        )
        snapshot["sources"]["mlb_hr_edge"] = {
            key: value for key, value in market.items() if key != "players"
        }
    except Exception as exc:
        snapshot["status"] = "shared_odds_source_unavailable"
        snapshot["diagnostics"].append(str(exc))
        write_json(snapshot_path, snapshot)
        rebuild(data_dir, ROOT)
        return 0

    if not market["players"]:
        snapshot["status"] = "shared_odds_not_available_at_checkpoint"
        write_json(snapshot_path, snapshot)
        rebuild(data_dir, ROOT)
        return 0

    try:
        day_schedule = schedule(client, checkpoint.slate_date)
        games = games_by_pk(day_schedule)
    except Exception as exc:
        games = {}
        snapshot["diagnostics"].append(f"MLB schedule unavailable: {exc}")

    logs: dict[int, list[dict] | Exception] = {}

    def fetch_log(row: dict) -> tuple[int, list[dict]]:
        player_id = int(row["batter_id"])
        return player_id, game_log(client, player_id, checkpoint.slate_date.year)

    with ThreadPoolExecutor(max_workers=18) as executor:
        futures = {
            executor.submit(fetch_log, row): row
            for row in market["players"]
        }
        for future in as_completed(futures):
            row = futures[future]
            player_id = int(row["batter_id"])
            try:
                _, player_games = future.result()
                logs[player_id] = player_games
            except Exception as exc:
                logs[player_id] = exc

    candidates: list[dict] = []
    checkpoint_utc = checkpoint.scheduled_at.astimezone(timezone.utc)

    for row in market["players"]:
        player_id = int(row["batter_id"])
        player_games = logs.get(player_id)
        if not isinstance(player_games, list):
            continue

        form = calculate_form(player_games, checkpoint.slate_date)
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
        if game_has_started(game, checkpoint_utc):
            continue

        prices = list(row["prices"])
        best = choose_best_price(prices)
        if not best or int(best["odds"]) < 500:
            continue

        draftkings = next(
            (price for price in prices if price.get("book_id") == "draftkings"),
            None,
        )
        start_raw = row.get("game_start_at") or (game or {}).get("gameDate")
        game_time_et = None
        if start_raw:
            game_time_et = (
                datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
                .astimezone(ET)
                .strftime("%-I:%M %p ET")
            )

        candidates.append(
            {
                "player": row["name"],
                "mlbam_id": player_id,
                "team_id": None,
                "slate_date": checkpoint.slate_date.isoformat(),
                **form,
                "best_odds": int(best["odds"]),
                "best_sportsbook": best["book"],
                "best_price_verified": True,
                "best_price_captured_at": best.get("captured_at"),
                "best_source_event_id": best.get("source_event_id"),
                "best_source_odd_id": best.get("source_odd_id"),
                "all_prices": prices,
                "dk_odds": int(draftkings["odds"]) if draftkings else None,
                "dk_url": None,
                "game_pk": game_pk,
                "game_time_utc": start_raw,
                "game_time_et": game_time_et,
                "opponent": row.get("matchup"),
                "batter_team": row.get("batter_team"),
                "lineup_position": row.get("lineup_position"),
                "source_prediction_id": row.get("prediction_id"),
            }
        )

    ranked = rank_candidates(candidates)
    for rank, row in enumerate(ranked, 1):
        row["rank"] = rank

    def frozen_pick(row: dict) -> dict:
        return {
            "rank": row["rank"],
            "player": row["player"],
            "mlbam_id": row["mlbam_id"],
            "team_id": row.get("team_id"),
            "slate_date": row["slate_date"],
            "score": row["score"],
            "hr_games_l5": row["hr_games_l5"],
            "hr_games_l7": row["hr_games_l7"],
            "hr_games_l15": row["hr_games_l15"],
            "home_runs_l15": row["home_runs_l15"],
            "odds": row["best_odds"],
            "sportsbook": row["best_sportsbook"],
            "best_price_verified": row["best_price_verified"],
            "best_price_captured_at": row["best_price_captured_at"],
            "best_source_event_id": row["best_source_event_id"],
            "best_source_odd_id": row["best_source_odd_id"],
            "dk_odds": row["dk_odds"],
            "dk_url": None,
            "all_prices": row["all_prices"],
            "game_pk": row["game_pk"],
            "game_time_utc": row["game_time_utc"],
            "game_time_et": row["game_time_et"],
            "opponent": row["opponent"],
            "batter_team": row["batter_team"],
            "lineup_position": row["lineup_position"],
            "source_prediction_id": row["source_prediction_id"],
            "settled": False,
            "result": "PENDING",
            "home_runs": None,
            "profit_units": None,
        }

    for key, count in (("top10", 10), ("top20", 20)):
        picks = [frozen_pick(row) for row in ranked[:count]]
        snapshot["portfolios"][key] = {
            "picks": picks,
            "summary": portfolio_summary(picks),
        }

    snapshot["eligible_candidates"] = len(ranked)
    snapshot["status"] = "frozen" if ranked else "no_eligible_players"
    write_json(snapshot_path, snapshot)
    rebuild(data_dir, ROOT)
    print(snapshot_path.name, snapshot["status"], len(ranked))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
