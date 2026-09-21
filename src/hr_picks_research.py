from __future__ import annotations

from collections import defaultdict
from datetime import date
from math import log1p, sqrt
from typing import Any, Callable

CHECKPOINTS = ("0817", "1117", "1717", "2017")
HOLDOUT_DAYS = 14

FORM_RULES = (
    ("all", "All scores", lambda row: True),
    ("100_199", "0.100–0.199", lambda row: 0.1 <= float(row.get("score") or 0) < 0.2),
    ("200_299", "0.200–0.299", lambda row: 0.2 <= float(row.get("score") or 0) < 0.3),
    ("300_399", "0.300–0.399", lambda row: 0.3 <= float(row.get("score") or 0) < 0.4),
    ("400p", "0.400+", lambda row: float(row.get("score") or 0) >= 0.4),
    ("100p", "0.100+", lambda row: float(row.get("score") or 0) >= 0.1),
    ("200p", "0.200+", lambda row: float(row.get("score") or 0) >= 0.2),
    ("300p", "0.300+", lambda row: float(row.get("score") or 0) >= 0.3),
)

ODDS_RULES = (
    ("all", "All odds", lambda row: True),
    ("u400", "Below +400", lambda row: int(row.get("best_odds")) < 400),
    ("400_499", "+400–499", lambda row: 400 <= int(row.get("best_odds")) < 500),
    ("500_599", "+500–599", lambda row: 500 <= int(row.get("best_odds")) < 600),
    ("600_799", "+600–799", lambda row: 600 <= int(row.get("best_odds")) < 800),
    ("800_999", "+800–999", lambda row: 800 <= int(row.get("best_odds")) < 1000),
    ("1000p", "+1000+", lambda row: int(row.get("best_odds")) >= 1000),
    ("400_599", "+400–599", lambda row: 400 <= int(row.get("best_odds")) < 600),
    ("400_799", "+400–799", lambda row: 400 <= int(row.get("best_odds")) < 800),
    ("500_799", "+500–799", lambda row: 500 <= int(row.get("best_odds")) < 800),
    ("600_999", "+600–999", lambda row: 600 <= int(row.get("best_odds")) < 1000),
    ("400p", "+400+", lambda row: int(row.get("best_odds")) >= 400),
    ("500p", "+500+", lambda row: int(row.get("best_odds")) >= 500),
    ("600p", "+600+", lambda row: int(row.get("best_odds")) >= 600),
)

BOOK_RULES = (
    ("all", "Any best-price book", lambda row: True),
    ("FD", "FanDuel", lambda row: row.get("best_book") == "FanDuel"),
    ("DK", "DraftKings", lambda row: row.get("best_book") == "DraftKings"),
    ("MGM", "BetMGM", lambda row: row.get("best_book") == "BetMGM"),
)

TOP_NS = (1, 2, 3, 5, 8, 10)


def _implied_probability(american_odds: int | float) -> float:
    odds = float(american_odds)
    if odds > 0:
        return 100.0 / (odds + 100.0)
    return abs(odds) / (abs(odds) + 100.0)


def _wilson_lower(wins: int, bets: int, z: float = 1.6448536269514722) -> float | None:
    if bets <= 0:
        return None
    p = wins / bets
    z2 = z * z
    denom = 1 + z2 / bets
    center = p + z2 / (2 * bets)
    spread = z * sqrt((p * (1 - p) + z2 / (4 * bets)) / bets)
    return (center - spread) / denom


def _settled(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("result") in {"WIN", "LOSS"}]


def _summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    graded = _settled(rows)
    wins = sum(row.get("result") == "WIN" for row in graded)
    losses = len(graded) - wins
    net_units = sum(float(row.get("profit_units") or 0.0) for row in graded)
    avg_break_even = (
        sum(_implied_probability(float(row["best_odds"])) for row in graded) / len(graded)
        if graded else None
    )
    hit_rate = wins / len(graded) if graded else None
    by_day: dict[str, float] = defaultdict(float)
    for row in graded:
        by_day[str(row.get("slate_date"))] += float(row.get("profit_units") or 0.0)
    day_values = list(by_day.values())
    profitable = [value for value in day_values if value > 0]
    positive_gross = sum(profitable)
    return {
        "bets": len(graded),
        "wins": wins,
        "losses": losses,
        "voids": sum(row.get("result") == "VOID" for row in rows),
        "slates": len(by_day),
        "hit_rate": hit_rate,
        "average_break_even": avg_break_even,
        "empirical_probability_edge": (
            hit_rate - avg_break_even
            if hit_rate is not None and avg_break_even is not None else None
        ),
        "lower90_hit_rate": _wilson_lower(wins, len(graded)),
        "net_units": round(net_units, 3),
        "roi": net_units / len(graded) if graded else None,
        "profitable_slates": len(profitable),
        "positive_slate_rate": len(profitable) / len(by_day) if by_day else None,
        "max_positive_day_share": (
            max(profitable) / positive_gross if positive_gross > 0 else None
        ),
    }


def _complete_dates(rows: list[dict[str, Any]], today: date) -> list[str]:
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        slate = str(row.get("slate_date") or "")
        if not slate or row.get("best_odds") is None:
            continue
        try:
            if date.fromisoformat(slate) >= today:
                continue
        except ValueError:
            continue
        by_date[slate].append(row)
    return sorted(
        slate for slate, values in by_date.items()
        if values and all(row.get("result") in {"WIN", "LOSS", "VOID"} for row in values)
    )


def _select(rows: list[dict[str, Any]], rule: dict[str, Any]) -> list[dict[str, Any]]:
    filtered = [
        row for row in rows
        if row.get("checkpoint") == rule["checkpoint"]
        and rule["_form_fn"](row)
        and rule["_odds_fn"](row)
        and rule["_book_fn"](row)
        and row.get("best_odds") is not None
        and row.get("result") in {"WIN", "LOSS", "VOID"}
    ]
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in filtered:
        by_date[str(row.get("slate_date"))].append(row)

    selected: list[dict[str, Any]] = []
    for slate in sorted(by_date):
        ordered = sorted(
            by_date[slate],
            key=lambda row: (
                -float(row.get("score") or 0.0),
                -float(row.get("best_odds") or -999999),
                int(row.get("rank") or 999),
                int(row.get("mlbam_id") or 0),
            ),
        )
        selected.extend(ordered[: int(rule["top_n"])])
    return selected


def _public_rule(rule: dict[str, Any] | None) -> dict[str, Any] | None:
    if not rule:
        return None
    return {
        "checkpoint": rule["checkpoint"],
        "form": rule["form_label"],
        "odds": rule["odds_label"],
        "book": rule["book_label"],
        "top_n": rule["top_n"],
        "ranking": "Highest form score, then best archived odds",
    }


def _public_pick(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "slate_date": row.get("slate_date"),
        "checkpoint": row.get("checkpoint"),
        "player": row.get("player"),
        "mlbam_id": row.get("mlbam_id"),
        "team": row.get("team"),
        "matchup": row.get("matchup"),
        "rank": row.get("rank"),
        "score": row.get("score"),
        "odds": row.get("best_odds"),
        "book": row.get("best_book"),
        "game_start_at": row.get("game_start_at"),
        "result": row.get("result"),
        "profit_units": row.get("profit_units"),
    }


def build_hr_picks_research(annotated: list[dict[str, Any]], today: date) -> dict[str, Any]:
    rows = [row for row in annotated if row.get("best_odds") is not None]
    complete_dates = _complete_dates(rows, today)
    if len(complete_dates) < HOLDOUT_DAYS + 12:
        return {
            "status": "collecting",
            "promoted": False,
            "message": "Not enough complete archived slates for calibration plus a 14-day untouched holdout.",
            "complete_dates": len(complete_dates),
        }

    holdout_dates = complete_dates[-HOLDOUT_DAYS:]
    calibration_dates = complete_dates[:-HOLDOUT_DAYS]
    split_at = calibration_dates[len(calibration_dates) // 2]
    early_dates = set(date_value for date_value in calibration_dates if date_value < split_at)
    late_dates = set(date_value for date_value in calibration_dates if date_value >= split_at)
    calibration_set = set(calibration_dates)
    holdout_set = set(holdout_dates)

    early_rows = [row for row in rows if row.get("slate_date") in early_dates]
    late_rows = [row for row in rows if row.get("slate_date") in late_dates]
    calibration_rows = [row for row in rows if row.get("slate_date") in calibration_set]
    holdout_rows = [row for row in rows if row.get("slate_date") in holdout_set]

    candidates: list[dict[str, Any]] = []
    per_checkpoint: dict[str, list[dict[str, Any]]] = {checkpoint: [] for checkpoint in CHECKPOINTS}

    for checkpoint in CHECKPOINTS:
        for form_id, form_label, form_fn in FORM_RULES:
            for odds_id, odds_label, odds_fn in ODDS_RULES:
                for book_id, book_label, book_fn in BOOK_RULES:
                    for top_n in TOP_NS:
                        rule = {
                            "checkpoint": checkpoint,
                            "form_id": form_id,
                            "form_label": form_label,
                            "_form_fn": form_fn,
                            "odds_id": odds_id,
                            "odds_label": odds_label,
                            "_odds_fn": odds_fn,
                            "book_id": book_id,
                            "book_label": book_label,
                            "_book_fn": book_fn,
                            "top_n": top_n,
                        }
                        early = _summary(_select(early_rows, rule))
                        late = _summary(_select(late_rows, rule))
                        full = _summary(_select(calibration_rows, rule))

                        if early["bets"] < 12 or early["slates"] < 8:
                            continue
                        if late["bets"] < 12 or late["slates"] < 8:
                            continue
                        if full["bets"] < 30 or full["slates"] < 16:
                            continue
                        if not (early["roi"] > 0 and late["roi"] > 0 and full["roi"] > 0):
                            continue
                        if not (
                            early["empirical_probability_edge"] > 0
                            and late["empirical_probability_edge"] > 0
                            and full["empirical_probability_edge"] > 0
                        ):
                            continue
                        if (
                            full["lower90_hit_rate"] is None
                            or full["average_break_even"] is None
                            or full["lower90_hit_rate"] <= full["average_break_even"]
                        ):
                            continue
                        if early["positive_slate_rate"] < 0.25 or late["positive_slate_rate"] < 0.25:
                            continue
                        if full["profitable_slates"] < 8:
                            continue
                        if (early["max_positive_day_share"] or 0) > 0.50:
                            continue
                        if (late["max_positive_day_share"] or 0) > 0.50:
                            continue
                        if (full["max_positive_day_share"] or 0) > 0.40:
                            continue

                        min_edge = min(
                            early["empirical_probability_edge"],
                            late["empirical_probability_edge"],
                        )
                        min_roi = min(early["roi"], late["roi"])
                        stability = (
                            abs(early["roi"] - late["roi"])
                            + 2 * abs(
                                early["empirical_probability_edge"]
                                - late["empirical_probability_edge"]
                            )
                        )
                        score = (
                            2 * min_edge
                            + 0.45 * min_roi
                            + 0.25 * full["roi"]
                            + 0.20 * full["positive_slate_rate"]
                            + min(0.08, log1p(full["bets"]) / 80)
                            - 0.15 * stability
                        )
                        holdout = _summary(_select(holdout_rows, rule))
                        candidate = {
                            "rule": rule,
                            "score": score,
                            "early": early,
                            "late": late,
                            "full": full,
                            "holdout": holdout,
                        }
                        candidates.append(candidate)
                        per_checkpoint[checkpoint].append(candidate)

    candidates.sort(
        key=lambda item: (
            item["score"],
            item["full"]["net_units"],
            item["full"]["bets"],
        ),
        reverse=True,
    )
    winner = candidates[0] if candidates else None

    holdout_pass = bool(
        winner
        and winner["holdout"]["bets"] >= 20
        and winner["holdout"]["slates"] >= 5
        and winner["holdout"]["roi"] is not None
        and winner["holdout"]["roi"] > 0
        and winner["holdout"]["profitable_slates"] >= 3
    )
    promoted = bool(winner and holdout_pass)

    def compact(candidate: dict[str, Any]) -> dict[str, Any]:
        return {
            "rule": _public_rule(candidate["rule"]),
            "score": round(float(candidate["score"]), 4),
            "early": candidate["early"],
            "late": candidate["late"],
            "full": candidate["full"],
            "holdout": candidate["holdout"],
        }

    checkpoint_leaders = {}
    for checkpoint, values in per_checkpoint.items():
        values.sort(
            key=lambda item: (
                item["score"],
                item["full"]["net_units"],
                item["full"]["bets"],
            ),
            reverse=True,
        )
        checkpoint_leaders[checkpoint] = [compact(item) for item in values[:3]]

    holdout_picks = _select(holdout_rows, winner["rule"]) if winner else []

    return {
        "status": "promoted" if promoted else ("hold" if winner else "no_stable_rule"),
        "promoted": promoted,
        "generated_through": complete_dates[-1],
        "methodology": {
            "search": "All four checkpoints × form bands × odds bands × best-price book × top-N per slate.",
            "ranking": "Within a slate, candidates are ranked by form score then archived best odds.",
            "calibration": "Only dates before the untouched 14-complete-slate holdout are used to choose the rule. Calibration is split into early and late halves and both halves must be profitable with minimum sample.",
            "guardrails": "Minimum early/late/full samples, positive empirical edge over market break-even, full-sample 90% Wilson lower hit-rate above average break-even, positive-slate requirements, and single-day profit concentration limits.",
            "promotion": "Mirrors the 2+ bases execution gate: frozen holdout must have at least 20 settled bets, at least 5 slates, positive ROI, and at least 3 profitable slates.",
            "execution": "No official HR Picks ledger entry is created until the winner clears promotion. Research holdout picks remain auditable but are not forward picks.",
        },
        "split": {
            "archive_start": complete_dates[0],
            "calibration_start": calibration_dates[0],
            "calibration_end": calibration_dates[-1],
            "internal_split": split_at,
            "holdout_start": holdout_dates[0],
            "holdout_end": holdout_dates[-1],
            "holdout_complete_slates": len(holdout_dates),
        },
        "winner": compact(winner) if winner else None,
        "checkpoint_leaders": checkpoint_leaders,
        "passing_candidates": len(candidates),
        "holdout_pass": holdout_pass,
        "promotion_gate": {
            "min_holdout_bets": 20,
            "min_holdout_slates": 5,
            "require_positive_roi": True,
            "min_profitable_slates": 3,
        },
        "holdout_ledger": [_public_pick(row) for row in holdout_picks],
    }
