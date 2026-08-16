from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from statistics import mean
from typing import Any, Callable, Iterable

from .discovery import decimal_odds, profit_units


CANONICAL_ODDS_ORDER = [
    "Below +400",
    "+400 to +499",
    "+500 to +599",
    "+600 to +799",
    "+800 to +999",
    "+1000 or longer",
]
LONG_ODDS_ORDER = [
    "Below +1000",
    "+1000 to +1499",
    "+1500 to +1999",
    "+2000 to +2999",
    "+3000 to +4999",
    "+5000 or longer",
]
SCORE_ORDER = [
    "0.200+",
    "0.150–0.199",
    "0.100–0.149",
    "0.050–0.099",
    "Below 0.050",
    "No recent-triples score",
]
RANK_ORDER = ["Ranks 1–10", "Ranks 11–25", "Ranks 26–50", "Ranks 51–100", "Unranked"]
BOOK_ORDER = ["fanduel", "draftkings", "betmgm"]
CHECKPOINT_ORDER = ["1117", "1717"]


def implied_probability(american: int) -> float:
    return 100.0 / (american + 100.0) if american > 0 else abs(american) / (abs(american) + 100.0)


def canonical_odds_band(american: int) -> str:
    if american < 400:
        return "Below +400"
    if american < 500:
        return "+400 to +499"
    if american < 600:
        return "+500 to +599"
    if american < 800:
        return "+600 to +799"
    if american < 1000:
        return "+800 to +999"
    return "+1000 or longer"


def long_odds_band(american: int) -> str:
    if american < 1000:
        return "Below +1000"
    if american < 1500:
        return "+1000 to +1499"
    if american < 2000:
        return "+1500 to +1999"
    if american < 3000:
        return "+2000 to +2999"
    if american < 5000:
        return "+3000 to +4999"
    return "+5000 or longer"


def triples_score_band(score: float | None) -> str:
    if score is None:
        return "No recent-triples score"
    if score >= 0.20:
        return "0.200+"
    if score >= 0.15:
        return "0.150–0.199"
    if score >= 0.10:
        return "0.100–0.149"
    if score >= 0.05:
        return "0.050–0.099"
    return "Below 0.050"


def rank_band(rank: int | None) -> str:
    if rank is None or rank > 100:
        return "Unranked"
    if rank <= 10:
        return "Ranks 1–10"
    if rank <= 25:
        return "Ranks 11–25"
    if rank <= 50:
        return "Ranks 26–50"
    return "Ranks 51–100"


def collapse_best(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one executable best price per player/slate, matching Form Discovery."""
    selected: dict[tuple[str, int], dict[str, Any]] = {}
    for row in entries:
        if row.get("best_odds") is None or row.get("mlbam_id") is None:
            continue
        key = (str(row["slate_date"]), int(row["mlbam_id"]))
        current = selected.get(key)
        if current is None or decimal_odds(int(row["best_odds"])) > decimal_odds(int(current["best_odds"])):
            selected[key] = row
    return sorted(selected.values(), key=lambda row: (row["slate_date"], int(row.get("rank") or 999), row.get("player") or ""))


def summary(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    rows = list(rows)
    settled = [row for row in rows if row.get("result") in {"WIN", "LOSS"}]
    wins = sum(row.get("result") == "WIN" for row in settled)
    losses = len(settled) - wins
    voids = sum(row.get("result") == "VOID" for row in rows)
    net = sum(float(row.get("profit_units") or 0.0) for row in settled)
    probabilities = [implied_probability(int(row["best_odds"])) for row in settled]
    slates = len({str(row.get("slate_date")) for row in settled})
    hit_rate = wins / len(settled) if settled else None
    break_even = mean(probabilities) if probabilities else None
    if len(settled) >= 100 and wins >= 5 and slates >= 7:
        sample_status = "larger sample"
    elif len(settled) >= 40 and wins >= 3 and slates >= 5:
        sample_status = "provisional"
    else:
        sample_status = "small sample"
    return {
        "captures": len(rows),
        "settled": len(settled),
        "slates": slates,
        "wins": wins,
        "losses": losses,
        "voids": voids,
        "pending": sum(row.get("result") in {None, "PENDING"} for row in rows),
        "hit_rate": hit_rate,
        "market_break_even_hit_rate": break_even,
        "hit_rate_edge": hit_rate - break_even if hit_rate is not None and break_even is not None else None,
        "net_units": net,
        "roi": net / len(settled) if settled else None,
        "average_odds": mean(int(row["best_odds"]) for row in settled) if settled else None,
        "average_score": mean(float(row["score"]) for row in settled if row.get("score") is not None)
        if any(row.get("score") is not None for row in settled)
        else None,
        "sample_status": sample_status,
    }


def grouped(
    rows: Iterable[dict[str, Any]],
    key_fn: Callable[[dict[str, Any]], str],
    order: list[str] | None = None,
) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[key_fn(row)].append(row)
    labels = order or sorted(buckets)
    return [{"label": label, **summary(buckets[label])} for label in labels if label in buckets]


def _edge_rows(
    rows: list[dict[str, Any]],
    dimension: str,
    key_fn: Callable[[dict[str, Any]], str],
) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[key_fn(row)].append(row)
    output = []
    for label, values in buckets.items():
        stats = summary(values)
        if (
            stats["settled"] >= 40
            and stats["wins"] >= 3
            and stats["slates"] >= 5
            and stats["net_units"] > 0
        ):
            output.append({"dimension": dimension, "rule": label, **stats})
    return output


def edge_candidates(best_rows: list[dict[str, Any]], checkpoint_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    benchmark_dimensions = [
        ("Best-price book", lambda row: str(row.get("best_book") or "unknown")),
        ("Long-odds band", lambda row: long_odds_band(int(row["best_odds"]))),
        ("Triples score", lambda row: triples_score_band(row.get("score"))),
        ("Top-100 rank", lambda row: rank_band(row.get("rank"))),
        (
            "Book × odds",
            lambda row: f"{row.get('best_book') or 'unknown'} · {long_odds_band(int(row['best_odds']))}",
        ),
        (
            "Score × odds",
            lambda row: f"{triples_score_band(row.get('score'))} · {long_odds_band(int(row['best_odds']))}",
        ),
        (
            "Book × score",
            lambda row: f"{row.get('best_book') or 'unknown'} · {triples_score_band(row.get('score'))}",
        ),
        (
            "Book × odds × score",
            lambda row: (
                f"{row.get('best_book') or 'unknown'} · "
                f"{long_odds_band(int(row['best_odds']))} · "
                f"{triples_score_band(row.get('score'))}"
            ),
        ),
    ]
    for dimension, key_fn in benchmark_dimensions:
        output.extend(
            {**row, "basis": "archive-best benchmark"}
            for row in _edge_rows(best_rows, dimension, key_fn)
        )

    fixed_dimensions = [
        ("Checkpoint", lambda row: str(row.get("checkpoint") or "unknown")),
        (
            "Checkpoint × odds",
            lambda row: f"{row.get('checkpoint')} · {long_odds_band(int(row['best_odds']))}",
        ),
        (
            "Checkpoint × book",
            lambda row: f"{row.get('checkpoint')} · {row.get('best_book') or 'unknown'}",
        ),
        (
            "Checkpoint × score",
            lambda row: f"{row.get('checkpoint')} · {triples_score_band(row.get('score'))}",
        ),
        (
            "Checkpoint × rank",
            lambda row: f"{row.get('checkpoint')} · {rank_band(row.get('rank'))}",
        ),
        (
            "Checkpoint × score × odds",
            lambda row: (
                f"{row.get('checkpoint')} · {triples_score_band(row.get('score'))} · "
                f"{long_odds_band(int(row['best_odds']))}"
            ),
        ),
    ]
    for dimension, key_fn in fixed_dimensions:
        output.extend(
            {**row, "basis": "fixed-checkpoint strategy"}
            for row in _edge_rows(checkpoint_rows, dimension, key_fn)
        )
    output.sort(
        key=lambda row: (
            -float(row.get("net_units") or 0.0),
            -int(row.get("settled") or 0),
            -float(row.get("roi") or 0.0),
            row.get("dimension") or "",
            row.get("rule") or "",
        )
    )
    return output


def period_report(entries: Iterable[dict[str, Any]], start: date, end: date) -> dict[str, Any]:
    filtered = [row for row in entries if start <= date.fromisoformat(row["slate_date"]) <= end]
    by_checkpoint = {
        checkpoint: collapse_best(row for row in filtered if row.get("checkpoint") == checkpoint)
        for checkpoint in CHECKPOINT_ORDER
    }
    checkpoint_rows = [row for rows in by_checkpoint.values() for row in rows]
    best_rows = collapse_best(filtered)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "raw_checkpoint_rows": len(filtered),
        "unique_player_slates": len(best_rows),
        "overall": summary(best_rows),
        "checkpoint_strategies": [
            {"label": checkpoint, **summary(by_checkpoint[checkpoint])}
            for checkpoint in CHECKPOINT_ORDER
        ],
        "best_price_books": grouped(best_rows, lambda row: str(row.get("best_book") or "unknown"), BOOK_ORDER),
        "odds_bands": grouped(best_rows, lambda row: canonical_odds_band(int(row["best_odds"])), CANONICAL_ODDS_ORDER),
        "long_odds_bands": grouped(best_rows, lambda row: long_odds_band(int(row["best_odds"])), LONG_ODDS_ORDER),
        "score_bands": grouped(best_rows, lambda row: triples_score_band(row.get("score")), SCORE_ORDER),
        "rank_bands": grouped(best_rows, lambda row: rank_band(row.get("rank")), RANK_ORDER),
        "edges": edge_candidates(best_rows, checkpoint_rows),
    }


def build_reports(entries: Iterable[dict[str, Any]], today: date) -> dict[str, Any]:
    entries = list(entries)
    dates = [date.fromisoformat(row["slate_date"]) for row in entries] or [today]
    first = min(dates)
    return {
        "rolling_14d": period_report(entries, today - timedelta(days=13), today),
        "calendar_month": period_report(entries, today.replace(day=1), today),
        "all_time": period_report(entries, first, today),
    }
