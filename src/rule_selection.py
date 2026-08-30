from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import mean
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

CHECKPOINTS = ("0817", "1117", "1717", "2017")
SCORE_BANDS = (
    ("0.400+", 0.40, None),
    ("0.300–0.399", 0.30, 0.40),
    ("0.200–0.299", 0.20, 0.30),
    ("0.100–0.199", 0.10, 0.20),
    ("Below 0.100", None, 0.10),
)
ODDS_BANDS = (
    ("Below +400", None, 400),
    ("+400 to +499", 400, 500),
    ("+500 to +599", 500, 600),
    ("+600 to +799", 600, 800),
    ("+800 to +999", 800, 1000),
    ("+1000 or longer", 1000, None),
)
RANK_BANDS = (
    ("Any rank", None, None),
    ("Ranks 1–10", 1, 11),
    ("Ranks 11–25", 11, 26),
    ("Ranks 26–50", 26, 51),
    ("Ranks 51–100", 51, 101),
)
BOOK_RULES = ("Any best book", "DraftKings", "FanDuel", "BetMGM")


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _american_profit(odds: int, result: str) -> float:
    if result == "LOSS":
        return -1.0
    if result == "WIN":
        return odds / 100.0 if odds > 0 else 100.0 / abs(odds)
    return 0.0


def _implied(odds: int) -> float:
    return 100.0 / (odds + 100.0) if odds > 0 else abs(odds) / (abs(odds) + 100.0)


def _score_match(score: float, low: float | None, high: float | None) -> bool:
    return (low is None or score >= low) and (high is None or score < high)


def _range_match(value: int, low: int | None, high: int | None) -> bool:
    return (low is None or value >= low) and (high is None or value < high)


def _best_books(row: dict[str, Any]) -> set[str]:
    explicit = row.get("best_books")
    if isinstance(explicit, list) and explicit:
        return {str(book) for book in explicit if book}
    best_odds = row.get("best_odds")
    prices = row.get("all_prices") or []
    tied = {
        str(price.get("book"))
        for price in prices
        if price.get("book") and price.get("odds") == best_odds
    }
    if tied:
        return tied
    return {str(row.get("best_book"))} if row.get("best_book") else set()


def _is_pregame(row: dict[str, Any]) -> bool:
    if row.get("game_started_at_checkpoint") is True:
        return False
    game = _parse_dt(row.get("game_start_at"))
    captured = _parse_dt(row.get("captured_at"))
    if game and captured:
        return captured < game
    return game is not None


def _is_early_game(row: dict[str, Any]) -> bool | None:
    game = _parse_dt(row.get("game_start_at"))
    if not game:
        return None
    local = game.astimezone(ET)
    return (local.hour, local.minute) < (17, 17)


def _settled_rows(entries: Iterable[dict[str, Any]], today: date) -> list[dict[str, Any]]:
    output = []
    for row in entries:
        try:
            slate = date.fromisoformat(str(row.get("slate_date")))
        except ValueError:
            continue
        if slate >= today:
            continue
        if row.get("result") not in {"WIN", "LOSS"}:
            continue
        if row.get("best_odds") is None or row.get("score") is None:
            continue
        if str(row.get("checkpoint") or "") not in CHECKPOINTS:
            continue
        if not _is_pregame(row):
            continue
        if _is_early_game(row) is None:
            continue
        output.append(row)
    return output


def _dedupe_checkpoint(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    chosen: dict[tuple[str, str, int, int], dict[str, Any]] = {}
    for row in entries:
        game_pk = int(row.get("game_pk") or 0)
        key = (
            str(row.get("slate_date")),
            str(row.get("checkpoint")),
            int(row.get("mlbam_id") or 0),
            game_pk,
        )
        current = chosen.get(key)
        if current is None:
            chosen[key] = row
            continue
        cur_dt = _parse_dt(current.get("captured_at"))
        new_dt = _parse_dt(row.get("captured_at"))
        if new_dt and (not cur_dt or new_dt < cur_dt):
            chosen[key] = row
    return list(chosen.values())


def _stats(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    values = list(rows)
    n = len(values)
    wins = sum(row.get("result") == "WIN" for row in values)
    losses = n - wins
    net = sum(_american_profit(int(row["best_odds"]), str(row["result"])) for row in values)
    break_even = mean(_implied(int(row["best_odds"])) for row in values) if values else None
    hit_rate = wins / n if n else None
    return {
        "settled": n,
        "wins": wins,
        "losses": losses,
        "slates": len({str(row.get("slate_date")) for row in values}),
        "hit_rate": hit_rate,
        "market_break_even_hit_rate": break_even,
        "hit_rate_edge": hit_rate - break_even if hit_rate is not None and break_even is not None else None,
        "net_units": net,
        "roi": net / n if n else None,
        "average_odds": mean(int(row["best_odds"]) for row in values) if values else None,
        "average_score": mean(float(row["score"]) for row in values) if values else None,
        "first_slate": min((str(row.get("slate_date")) for row in values), default=None),
        "last_slate": max((str(row.get("slate_date")) for row in values), default=None),
    }


def _split_stats(rows: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    dates = sorted({str(row.get("slate_date")) for row in rows})
    if not dates:
        return _stats([]), _stats([])
    split = max(1, len(dates) // 2)
    first_dates = set(dates[:split])
    second_dates = set(dates[split:])
    return (
        _stats(row for row in rows if str(row.get("slate_date")) in first_dates),
        _stats(row for row in rows if str(row.get("slate_date")) in second_dates),
    )


def _recent_stats(rows: list[dict[str, Any]], days: int = 14) -> dict[str, Any]:
    if not rows:
        return _stats([])
    end = max(date.fromisoformat(str(row["slate_date"])) for row in rows)
    start = end - timedelta(days=days - 1)
    return _stats(
        row for row in rows
        if start <= date.fromisoformat(str(row["slate_date"])) <= end
    )


def _odds_patterns() -> list[tuple[str, tuple[int, ...]]]:
    patterns = [(label, (idx,)) for idx, (label, _, _) in enumerate(ODDS_BANDS)]
    patterns.extend(
        (
            f"{ODDS_BANDS[idx][0]} OR {ODDS_BANDS[idx + 1][0]}",
            (idx, idx + 1),
        )
        for idx in range(len(ODDS_BANDS) - 1)
    )
    patterns.append(("Below +400 OR +500 to +599", (0, 2)))
    return patterns


def _odds_match(odds: int, indices: tuple[int, ...]) -> bool:
    return any(_range_match(odds, ODDS_BANDS[idx][1], ODDS_BANDS[idx][2]) for idx in indices)


def _rank_match(rank: int, label: str, low: int | None, high: int | None) -> bool:
    if label == "Any rank":
        return True
    return _range_match(rank, low, high)


def _complexity_penalty(book_rule: str, rank_label: str, odds_indices: tuple[int, ...]) -> float:
    penalty = 0.0
    if book_rule != "Any best book":
        penalty += 0.015
    if rank_label != "Any rank":
        penalty += 0.020
    if len(odds_indices) > 1:
        penalty += 0.010
    if len(odds_indices) > 1 and max(odds_indices) - min(odds_indices) > 1:
        penalty += 0.015
    return penalty


def _selection_score(
    overall: dict[str, Any],
    first: dict[str, Any],
    second: dict[str, Any],
    recent: dict[str, Any],
    penalty: float,
) -> float:
    def shrink(stats: dict[str, Any], prior: int) -> float:
        n = int(stats.get("settled") or 0)
        roi = float(stats.get("roi") or 0.0)
        return roi * n / (n + prior)

    half_floor = min(
        shrink(first, 30) if first.get("settled") else -1.0,
        shrink(second, 30) if second.get("settled") else -1.0,
    )
    return (
        0.50 * shrink(overall, 50)
        + 0.20 * shrink(second, 30)
        + 0.15 * shrink(recent, 30)
        + 0.15 * half_floor
        - penalty
    )


def _candidate_rows(
    pool: list[dict[str, Any]],
    checkpoint: str,
    score_bounds: tuple[float | None, float | None],
    odds_indices: tuple[int, ...],
    book_rule: str,
    rank_rule: tuple[str, int | None, int | None],
) -> list[dict[str, Any]]:
    score_low, score_high = score_bounds
    rank_label, rank_low, rank_high = rank_rule
    selected = []
    for row in pool:
        if str(row.get("checkpoint")) != checkpoint:
            continue
        score = float(row.get("score") or 0.0)
        odds = int(row["best_odds"])
        rank = int(row.get("rank") or 999)
        if not _score_match(score, score_low, score_high):
            continue
        if not _odds_match(odds, odds_indices):
            continue
        if not _rank_match(rank, rank_label, rank_low, rank_high):
            continue
        if book_rule != "Any best book" and book_rule not in _best_books(row):
            continue
        selected.append(row)
    return selected


def _eligible(stats: dict[str, Any]) -> bool:
    return (
        int(stats.get("settled") or 0) >= 40
        and int(stats.get("wins") or 0) >= 4
        and int(stats.get("slates") or 0) >= 5
        and float(stats.get("net_units") or 0.0) > 0
    )


def _stable(first: dict[str, Any], second: dict[str, Any]) -> bool:
    return (
        int(first.get("settled") or 0) >= 10
        and int(second.get("settled") or 0) >= 10
        and float(second.get("roi") or 0.0) > 0
        and float(first.get("roi") or 0.0) > -0.10
    )


def search_rules(
    entries: Iterable[dict[str, Any]],
    today: date,
    game_window: str,
) -> list[dict[str, Any]]:
    base = _dedupe_checkpoint(_settled_rows(entries, today))
    if game_window == "early":
        pool = [row for row in base if _is_early_game(row) is True]
        checkpoints = ("0817", "1117")
    elif game_window == "late":
        pool = [row for row in base if _is_early_game(row) is False]
        checkpoints = ("0817", "1117", "1717", "2017")
    else:
        raise ValueError(f"Unknown game window: {game_window}")

    output: list[dict[str, Any]] = []
    for checkpoint in checkpoints:
        for score_label, score_low, score_high in SCORE_BANDS:
            for odds_label, odds_indices in _odds_patterns():
                for book_rule in BOOK_RULES:
                    for rank_rule in RANK_BANDS:
                        rows = _candidate_rows(
                            pool,
                            checkpoint,
                            (score_low, score_high),
                            odds_indices,
                            book_rule,
                            rank_rule,
                        )
                        overall = _stats(rows)
                        if not _eligible(overall):
                            continue
                        first, second = _split_stats(rows)
                        recent = _recent_stats(rows)
                        stable = _stable(first, second)
                        score = _selection_score(
                            overall,
                            first,
                            second,
                            recent,
                            _complexity_penalty(book_rule, rank_rule[0], odds_indices),
                        )
                        output.append({
                            "game_window": game_window,
                            "checkpoint": checkpoint,
                            "score_band": score_label,
                            "score_min": score_low,
                            "score_max_exclusive": score_high,
                            "odds_rule": odds_label,
                            "odds_band_indices": list(odds_indices),
                            "book_rule": book_rule,
                            "rank_rule": rank_rule[0],
                            "overall": overall,
                            "first_half": first,
                            "second_half": second,
                            "recent_14d": recent,
                            "stable": stable,
                            "selection_score": score,
                        })
    output.sort(
        key=lambda row: (
            not bool(row["stable"]),
            -float(row["selection_score"]),
            -float(row["overall"]["net_units"]),
            -int(row["overall"]["settled"]),
        )
    )
    return output


def _current_rule_stats(entries: Iterable[dict[str, Any]], today: date, game_window: str) -> dict[str, Any]:
    base = _dedupe_checkpoint(_settled_rows(entries, today))
    pool = [
        row for row in base
        if (_is_early_game(row) is True) == (game_window == "early")
    ]
    if game_window == "early":
        rows = [
            row for row in pool
            if str(row.get("checkpoint")) == "0817"
            and 0.10 <= float(row.get("score") or 0.0) < 0.20
            and (int(row["best_odds"]) < 400 or 500 <= int(row["best_odds"]) < 600)
            and "DraftKings" in _best_books(row)
        ]
        definition = "0817 · 0.100–0.199 · DraftKings best/tied-best · Below +400 OR +500–599"
    else:
        rows = [
            row for row in pool
            if str(row.get("checkpoint")) == "1717"
            and 0.10 <= float(row.get("score") or 0.0) < 0.20
            and 600 <= int(row["best_odds"]) < 800
        ]
        definition = "1717 · 0.100–0.199 · Any best book · +600–799"
    first, second = _split_stats(rows)
    return {
        "definition": definition,
        "overall": _stats(rows),
        "first_half": first,
        "second_half": second,
        "recent_14d": _recent_stats(rows),
        "stable": _stable(first, second),
    }


def _public_rule(candidate: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in candidate.items() if key not in {"selection_score"}}


def build_rule_selection(entries: Iterable[dict[str, Any]], today: date) -> dict[str, Any]:
    entries = list(entries)
    settled = _dedupe_checkpoint(_settled_rows(entries, today))
    early_candidates = search_rules(entries, today, "early")
    late_candidates = search_rules(entries, today, "late")
    early_stable = [row for row in early_candidates if row["stable"]]
    late_stable = [row for row in late_candidates if row["stable"]]
    early_selected = early_stable[0] if early_stable else (early_candidates[0] if early_candidates else None)
    late_selected = late_stable[0] if late_stable else (late_candidates[0] if late_candidates else None)

    dates = sorted({str(row.get("slate_date")) for row in settled})
    return {
        "schema_version": 1,
        "kind": "hr_rule_selection",
        "generated_for": today.isoformat(),
        "archive_first_settled_slate": dates[0] if dates else None,
        "archive_last_settled_slate": dates[-1] if dates else None,
        "settled_fixed_checkpoint_rows_analyzed": len(settled),
        "methodology": {
            "primary_basis": "Entire available settled archive, fixed executable checkpoint prices only.",
            "current_slate": "Excluded to prevent partially settled games from entering rule selection.",
            "game_split": "Early starts before 5:17 PM ET; late starts at or after 5:17 PM ET.",
            "candidate_grid": "Checkpoint × form-score band × constrained odds band/pair × best-book identity × rank band.",
            "evidence_gate": "At least 40 settled bets, 4 wins, 5 slates, and positive all-time net units.",
            "stability_gate": "At least 10 bets in each chronological half, positive second-half ROI, first-half ROI above -10%.",
            "selection": "Shrinkage-weighted all-time, second-half, recent-14-day and weaker-half ROI with complexity penalties.",
        },
        "current_rules": {
            "early": _current_rule_stats(entries, today, "early"),
            "late": _current_rule_stats(entries, today, "late"),
        },
        "selected": {
            "early": _public_rule(early_selected) if early_selected else None,
            "late": _public_rule(late_selected) if late_selected else None,
        },
        "top_candidates": {
            "early": [_public_rule(row) for row in early_candidates[:15]],
            "late": [_public_rule(row) for row in late_candidates[:15]],
        },
    }
