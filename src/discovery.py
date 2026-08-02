from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from statistics import mean
from typing import Any, Callable, Iterable


def decimal_odds(american: int) -> float:
    return 1.0 + (american / 100.0 if american > 0 else 100.0 / abs(american))


def best_price(prices: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    valid = [row for row in prices if isinstance(row.get("odds"), int) and row["odds"] != 0]
    return max(valid, key=lambda row: (decimal_odds(row["odds"]), row.get("book", ""))) if valid else None


def profit_units(american: int | None, result: str | None) -> float | None:
    if result == "VOID":
        return 0.0
    if american is None or result not in {"WIN", "LOSS"}:
        return None
    if result == "LOSS":
        return -1.0
    return decimal_odds(american) - 1.0


def odds_band(american: int) -> str:
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


def score_band(score: float) -> str:
    if score >= 0.40:
        return "0.400+"
    if score >= 0.30:
        return "0.300–0.399"
    if score >= 0.20:
        return "0.200–0.299"
    if score >= 0.10:
        return "0.100–0.199"
    return "Below 0.100"


def rank_band(rank: int) -> str:
    if rank <= 10:
        return "Ranks 1–10"
    if rank <= 25:
        return "Ranks 11–25"
    if rank <= 50:
        return "Ranks 26–50"
    return "Ranks 51–100"


def collapse_best_player_games(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Use the best archived price once per player per slate for ROI analysis."""
    selected: dict[tuple[str, int], dict[str, Any]] = {}
    for row in entries:
        if row.get("best_odds") is None:
            continue
        key = (str(row.get("slate_date")), int(row.get("mlbam_id")))
        current = selected.get(key)
        if current is None or decimal_odds(int(row["best_odds"])) > decimal_odds(int(current["best_odds"])):
            selected[key] = row
    return sorted(selected.values(), key=lambda row: (row.get("slate_date", ""), row.get("rank", 999), row.get("player", "")))


def summary(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    rows = list(rows)
    settled = [row for row in rows if row.get("result") in {"WIN", "LOSS"}]
    wins = sum(row.get("result") == "WIN" for row in settled)
    losses = sum(row.get("result") == "LOSS" for row in settled)
    voids = sum(row.get("result") == "VOID" for row in rows)
    net = sum(float(row.get("profit_units") or 0.0) for row in settled)
    return {
        "captures": len(rows),
        "settled": len(settled),
        "wins": wins,
        "losses": losses,
        "voids": voids,
        "pending": sum(row.get("result") in {None, "PENDING"} for row in rows),
        "hit_rate": wins / len(settled) if settled else None,
        "net_units": net,
        "roi": net / len(settled) if settled else None,
        "average_odds": mean(int(row["best_odds"]) for row in rows if row.get("best_odds") is not None) if rows else None,
        "average_score": mean(float(row.get("score") or 0.0) for row in rows) if rows else None,
    }


def grouped(rows: Iterable[dict[str, Any]], key_fn: Callable[[dict[str, Any]], str], order: list[str]) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[key_fn(row)].append(row)
    result = []
    for label in order:
        if label not in buckets:
            continue
        result.append({"label": label, **summary(buckets[label])})
    return result


def _streaks(rows: list[dict[str, Any]]) -> tuple[str, int, int]:
    settled = [row for row in sorted(rows, key=lambda x: x.get("slate_date", "")) if row.get("result") in {"WIN", "LOSS"}]
    if not settled:
        return "—", 0, 0
    longest_hit = longest_miss = current_len = 0
    current_result = None
    for row in settled:
        result = row["result"]
        if result == current_result:
            current_len += 1
        else:
            current_result = result
            current_len = 1
        if result == "WIN":
            longest_hit = max(longest_hit, current_len)
        else:
            longest_miss = max(longest_miss, current_len)
    current = f"{current_len} hit{'s' if current_len != 1 else ''}" if current_result == "WIN" else f"{current_len} miss{'es' if current_len != 1 else ''}"
    return current, longest_hit, longest_miss


def player_summaries(rows: Iterable[dict[str, Any]], limit: int = 30) -> list[dict[str, Any]]:
    buckets: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[int(row["mlbam_id"])].append(row)
    output = []
    for player_rows in buckets.values():
        stats = summary(player_rows)
        current_streak, longest_hit, longest_miss = _streaks(player_rows)
        first = player_rows[0]
        output.append({
            "player": first.get("player"),
            "mlbam_id": first.get("mlbam_id"),
            "team": first.get("team"),
            **stats,
            "current_streak": current_streak,
            "longest_hit_streak": longest_hit,
            "longest_miss_streak": longest_miss,
        })
    output.sort(key=lambda row: (-float(row.get("net_units") or 0.0), -(row.get("settled") or 0), -float(row.get("roi") or -999), row.get("player") or ""))
    return output[:limit]


def period_report(rows: Iterable[dict[str, Any]], start: date, end: date) -> dict[str, Any]:
    filtered = [row for row in rows if start <= date.fromisoformat(row["slate_date"]) <= end]
    unique = collapse_best_player_games(filtered)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "raw_checkpoint_captures": len(filtered),
        "unique_player_games": len(unique),
        "overall": summary(unique),
        "odds_bands": grouped(unique, lambda row: odds_band(int(row["best_odds"])), ["Below +400", "+400 to +499", "+500 to +599", "+600 to +799", "+800 to +999", "+1000 or longer"]),
        "score_bands": grouped(unique, lambda row: score_band(float(row.get("score") or 0.0)), ["0.400+", "0.300–0.399", "0.200–0.299", "0.100–0.199", "Below 0.100"]),
        "rank_bands": grouped(unique, lambda row: rank_band(int(row.get("rank") or 999)), ["Ranks 1–10", "Ranks 11–25", "Ranks 26–50", "Ranks 51–100"]),
        "players": player_summaries(unique),
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
