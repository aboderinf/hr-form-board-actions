from __future__ import annotations

from datetime import date
from typing import Any, Iterable


def _qualifying_prior_games(
    games: Iterable[dict[str, Any]], slate: date
) -> list[dict[str, Any]]:
    prior = [
        game
        for game in games
        if game.get("date")
        and date.fromisoformat(game["date"]) < slate
        and int(game.get("plateAppearances", 0)) > 0
    ]
    prior.sort(key=lambda game: (game["date"], int(game.get("gamePk") or 0)))
    return prior[-15:]


def calculate_triples_form_open_pool(
    games: Iterable[dict[str, Any]], slate: date
) -> dict[str, Any] | None:
    """Score every hitter with a triple in the available prior 15 PA-games.

    Fixed 5/7/15 denominators keep short samples comparable and mirror the
    board's existing form-score convention. The score is descriptive, not a
    probability or fair-odds estimate.
    """
    prior = _qualifying_prior_games(games, slate)
    if not prior:
        return None

    recent = list(reversed(prior[-15:]))
    indicators = [int(int(game.get("triples", 0)) > 0) for game in recent]
    t5 = sum(indicators[:5])
    t7 = sum(indicators[:7])
    t15 = sum(indicators[:15])
    if t15 == 0:
        return None

    score = 0.50 * t5 / 5 + 0.30 * t7 / 7 + 0.20 * t15 / 15
    return {
        "score": score,
        "triple_games_l5": t5,
        "triple_games_l7": t7,
        "triple_games_l15": t15,
        "triples_l15": sum(int(game.get("triples", 0)) for game in recent),
        "games_available": len(recent),
        "provisional": len(recent) < 15,
        "recent_games": [
            {
                "date": game.get("date"),
                "game_pk": game.get("gamePk"),
                "opponent": game.get("opponent"),
                "triples": int(game.get("triples", 0)),
                "plate_appearances": int(game.get("plateAppearances", 0)),
                "triple_game": int(game.get("triples", 0)) > 0,
            }
            for game in recent
        ],
    }


def rank_triples_scores(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        rows,
        key=lambda row: (
            -row["score"],
            -row["triple_games_l5"],
            -row["triple_games_l7"],
            -row["triple_games_l15"],
            -row["triples_l15"],
            -row["games_available"],
            row["player"],
        ),
    )
