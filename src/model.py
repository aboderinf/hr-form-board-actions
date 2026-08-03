from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
CHECKPOINTS = ("08:17", "11:17", "17:17", "20:17")


@dataclass(frozen=True)
class Checkpoint:
    slate_date: date
    label: str
    scheduled_at: datetime

    @property
    def snapshot_id(self) -> str:
        return f"{self.slate_date.isoformat()}_{self.label.replace(':', '')}"


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(c for c in value if not unicodedata.combining(c))
    value = value.lower().replace("’", "'")
    value = re.sub(r"\b(jr|sr|ii|iii|iv)\.?\b", "", value)
    value = re.sub(r"[^a-z0-9]+", "", value)
    return {"kikehernandez": "enriquehernandez"}.get(value, value)


def american_odds(text: str) -> int | None:
    matches = re.findall(
        r"(?<!\d)([+-]\d{3,5})(?!\d)",
        (text or "").replace("−", "-").replace("–", "-"),
    )
    return int(matches[-1]) if matches else None


def choose_checkpoint(
    now: datetime | None = None, tolerance_minutes: int = 100
) -> Checkpoint | None:
    now = (now or datetime.now(timezone.utc)).astimezone(ET)
    candidates: list[Checkpoint] = []
    for offset in (0, -1):
        day = now.date() + timedelta(days=offset)
        for label in CHECKPOINTS:
            hour, minute = map(int, label.split(":"))
            scheduled = datetime.combine(day, time(hour, minute), ET)
            delta = now - scheduled
            if timedelta(0) <= delta <= timedelta(minutes=tolerance_minutes):
                candidates.append(Checkpoint(day, label, scheduled))
    return max(candidates, key=lambda x: x.scheduled_at) if candidates else None


def explicit_checkpoint(day: str, label: str) -> Checkpoint:
    if label not in CHECKPOINTS:
        raise ValueError(label)
    slate_date = date.fromisoformat(day)
    hour, minute = map(int, label.split(":"))
    return Checkpoint(
        slate_date,
        label,
        datetime.combine(slate_date, time(hour, minute), ET),
    )


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


def calculate_form(
    games: Iterable[dict[str, Any]], slate: date
) -> dict[str, Any] | None:
    """Locked benchmark score for players with 15 prior PA-games."""
    prior = _qualifying_prior_games(games, slate)
    if len(prior) < 15:
        return None
    return _form_from_prior(prior, provisional=False)


def calculate_form_open_pool(
    games: Iterable[dict[str, Any]], slate: date
) -> dict[str, Any] | None:
    """Comparable form score for all hitters, including recent call-ups.

    The original denominators (5, 7 and 15) remain fixed. Missing pre-debut
    games therefore contribute zero rather than turning a one-game sample into
    a perfect score. A player enters the table after any qualifying PA-game and
    can rank once at least one of the available games contains a home run.
    """
    prior = _qualifying_prior_games(games, slate)
    if not prior:
        return None
    result = _form_from_prior(prior, provisional=len(prior) < 15)
    if result["hr_games_l15"] == 0:
        return None
    return result


def _display_game(game: dict[str, Any]) -> dict[str, Any]:
    """Serialize one MLB game consistently for the browser form strip."""
    home_runs = int(game.get("homeRuns", 0))
    return {
        "date": game.get("date"),
        "game_pk": game.get("gamePk"),
        "opponent": game.get("opponent"),
        "home_runs": home_runs,
        "plate_appearances": int(game.get("plateAppearances", 0)),
        "hr_game": home_runs > 0,
    }


def _form_from_prior(
    prior: list[dict[str, Any]], *, provisional: bool
) -> dict[str, Any]:
    recent = list(reversed(prior[-15:]))
    indicators = [int(int(game.get("homeRuns", 0)) > 0) for game in recent]
    h5 = sum(indicators[:5])
    h7 = sum(indicators[:7])
    h15 = sum(indicators[:15])
    score = 0.50 * h5 / 5 + 0.30 * h7 / 7 + 0.20 * h15 / 15
    return {
        "score": score,
        "hr_games_l5": h5,
        "hr_games_l7": h7,
        "hr_games_l15": h15,
        "home_runs_l15": sum(int(game.get("homeRuns", 0)) for game in recent),
        "games_available": len(recent),
        "provisional": provisional,
        "recent_games": [_display_game(game) for game in recent],
    }


def rank_form_scores(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank the odds-independent all-hitter form table."""
    return sorted(
        rows,
        key=lambda row: (
            -row["score"],
            -row["hr_games_l5"],
            -row["hr_games_l7"],
            -row["hr_games_l15"],
            -row["home_runs_l15"],
            -row["games_available"],
            row["player"],
        ),
    )


def rank_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        rows,
        key=lambda row: (
            -row["score"],
            -row["hr_games_l5"],
            -row["hr_games_l7"],
            -row["hr_games_l15"],
            -row["best_odds"],
            row["player"],
        ),
    )


def choose_best_price(prices: list[dict[str, Any]]) -> dict[str, Any] | None:
    valid = [price for price in prices if isinstance(price.get("odds"), int)]
    return (
        max(
            valid,
            key=lambda price: (
                price["odds"],
                bool(price.get("verified")),
                price.get("book", ""),
            ),
        )
        if valid
        else None
    )


def game_has_started(game: dict | None, now: datetime) -> bool:
    if not game:
        return False
    if str(game.get("abstractState", "")).lower() in {"live", "final"}:
        return True
    raw = game.get("gameDate")
    return bool(
        raw
        and now.astimezone(timezone.utc)
        >= datetime.fromisoformat(raw.replace("Z", "+00:00"))
    )


def settle_pick(pick: dict, games: list[dict], game: dict | None) -> dict:
    rows = [
        row
        for row in games
        if row.get("date") == pick["slate_date"]
        and int(row.get("plateAppearances", 0)) > 0
    ]
    if rows:
        home_runs = sum(int(row.get("homeRuns", 0)) for row in rows)
        win = home_runs > 0
        return {
            "settled": True,
            "result": "WIN" if win else "LOSS",
            "home_runs": home_runs,
            "profit_units": pick["odds"] / 100 if win else -1.0,
        }
    if game and str(game.get("abstractState", "")).lower() == "final":
        return {
            "settled": True,
            "result": "PUSH",
            "home_runs": 0,
            "profit_units": 0.0,
        }
    return {
        "settled": False,
        "result": "PENDING",
        "home_runs": None,
        "profit_units": None,
    }


def portfolio_summary(picks: list[dict]) -> dict:
    settled = [pick for pick in picks if pick.get("settled")]
    wins = sum(pick.get("result") == "WIN" for pick in settled)
    losses = sum(pick.get("result") == "LOSS" for pick in settled)
    pushes = sum(pick.get("result") == "PUSH" for pick in settled)
    graded = wins + losses
    net = sum(float(pick.get("profit_units") or 0) for pick in settled)
    return {
        "selections": len(picks),
        "settled": len(settled),
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "hit_rate": wins / graded if graded else None,
        "net_units": net,
        "roi": net / graded if graded else None,
    }
