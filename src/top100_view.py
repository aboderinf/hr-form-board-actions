from __future__ import annotations

from datetime import date
from typing import Any, Iterable

from .model import choose_best_price, normalize_name


def compact_recent_games(games: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a safe, compact newest-first representation of up to 15 games."""
    output: list[dict[str, Any]] = []
    for game in list(games)[:15]:
        home_runs = int(game.get("homeRuns") or 0)
        output.append(
            {
                "date": game.get("date"),
                "game_pk": game.get("gamePk"),
                "opponent": game.get("opponent"),
                "home_runs": home_runs,
                "plate_appearances": int(game.get("plateAppearances") or 0),
                "hr_game": home_runs > 0,
            }
        )
    return output


def attach_market_data(
    players: list[dict[str, Any]],
    edge: dict[str, Any] | None,
    slate_date: date,
) -> dict[str, Any]:
    """Attach optional MLB HR Edge prices without affecting form rankings."""
    source_date = str((edge or {}).get("source_date") or "")
    same_slate = source_date == slate_date.isoformat()
    by_id: dict[int, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}

    if same_slate:
        for market in (edge or {}).get("players") or []:
            batter_id = market.get("batter_id")
            if batter_id:
                by_id[int(batter_id)] = market
            key = normalize_name(str(market.get("name") or ""))
            if key:
                by_name[key] = market

    priced = 0
    for player in players:
        player["recent_games"] = compact_recent_games(player.get("recent_games") or [])
        market = by_id.get(int(player["mlbam_id"])) or by_name.get(
            normalize_name(str(player.get("player") or ""))
        )
        prices = [dict(price) for price in ((market or {}).get("prices") or [])]
        best = choose_best_price(prices)
        if best:
            priced += 1

        player["all_prices"] = prices
        player["odds_available"] = best is not None
        player["best_odds"] = best.get("odds") if best else None
        player["best_book"] = best.get("book") if best else None
        player["odds_captured_at"] = best.get("captured_at") if best else None
        player["source_event_id"] = best.get("source_event_id") if best else None
        player["source_odd_id"] = best.get("source_odd_id") if best else None
        player["game_pk"] = (market or {}).get("game_pk")
        player["game_start_at"] = (market or {}).get("game_start_at")
        player["matchup"] = (market or {}).get("matchup")

    return {
        "source": "MLB HR Edge",
        "source_date": source_date or None,
        "same_slate": same_slate,
        "status": (edge or {}).get("status") or "unavailable",
        "generated_at": (edge or {}).get("generated_at"),
        "books": (edge or {}).get("books") or [],
        "priced_players": priced,
        "coverage": priced / len(players) if players else None,
    }
