from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import mean
from typing import Any, Iterable
from zoneinfo import ZoneInfo

CHECKPOINTS = ("0817", "1117", "1717", "2017")
ET = ZoneInfo("America/New_York")

DEVELOPMENT_START = date(2026, 8, 18)
DEVELOPMENT_END = date(2026, 9, 11)
VALIDATION_START = date(2026, 9, 12)
VALIDATION_END = date(2026, 9, 25)
FORWARD_START = date(2026, 9, 26)

EVIDENCE_MIN_SETTLED = 40
EVIDENCE_MIN_WINS = 4
EVIDENCE_MIN_SLATES = 5
TRAILING_14_MIN_SETTLED = 20
TRAILING_14_MIN_ROI = 0.10
TRAILING_30_MIN_SETTLED = 5
TOP_CELLS_PER_CHECKPOINT = 3
MAX_PICKS_PER_CHECKPOINT = 2

SCORE_BANDS = (
    ("400p", "0.400+"),
    ("300_399", "0.300–0.399"),
    ("200_299", "0.200–0.299"),
    ("100_199", "0.100–0.199"),
    ("u100", "Below 0.100"),
)


def _iso(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _instant(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def american_profit(odds: int | float | None) -> float | None:
    if odds is None:
        return None
    value = float(odds)
    if value == 0:
        return None
    return value / 100.0 if value > 0 else 100.0 / abs(value)


def implied_probability(odds: int | float | None) -> float | None:
    if odds is None:
        return None
    value = float(odds)
    if value == 0:
        return None
    if value > 0:
        return 100.0 / (value + 100.0)
    return abs(value) / (abs(value) + 100.0)


def score_band_id(score: float) -> str:
    if score >= 0.40:
        return "400p"
    if score >= 0.30:
        return "300_399"
    if score >= 0.20:
        return "200_299"
    if score >= 0.10:
        return "100_199"
    return "u100"


def score_band_label(rule_id: str) -> str:
    return next((label for value, label in SCORE_BANDS if value == rule_id), rule_id)


def checkpoint_scheduled_at(row: dict[str, Any]) -> datetime | None:
    slate = _iso(row.get("slate_date"))
    checkpoint = str(row.get("checkpoint") or "")
    if slate is None or checkpoint not in CHECKPOINTS:
        return None
    hour, minute = int(checkpoint[:2]), int(checkpoint[2:])
    return datetime(slate.year, slate.month, slate.day, hour, minute, tzinfo=ET).astimezone(timezone.utc)


def pregame_eligible(row: dict[str, Any]) -> bool:
    if row.get("game_started_at_checkpoint") is True:
        return False
    starts = _instant(row.get("game_start_at"))
    scheduled = checkpoint_scheduled_at(row)
    if starts is None or scheduled is None:
        return False
    return starts > scheduled


def cell_key(row: dict[str, Any]) -> tuple[str, str, str] | None:
    if row.get("best_odds") is None or not row.get("best_book"):
        return None
    try:
        return (
            str(row.get("checkpoint") or ""),
            str(row.get("best_book") or ""),
            score_band_id(float(row.get("score") or 0.0)),
        )
    except (TypeError, ValueError):
        return None


def _summary(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    values = list(rows)
    settled = [row for row in values if row.get("result") in {"WIN", "LOSS"}]
    wins = sum(row.get("result") == "WIN" for row in settled)
    net = sum(float(row.get("profit_units") or 0.0) for row in settled)
    return {
        "settled": len(settled),
        "wins": wins,
        "losses": len(settled) - wins,
        "voids": sum(row.get("result") == "VOID" for row in values),
        "slates": len({str(row.get("slate_date")) for row in settled}),
        "net_units": round(net, 3),
        "roi": net / len(settled) if settled else None,
        "hit_rate": wins / len(settled) if settled else None,
    }


def _evidence_gate(stats: dict[str, Any]) -> bool:
    return bool(
        int(stats.get("settled") or 0) >= EVIDENCE_MIN_SETTLED
        and int(stats.get("wins") or 0) >= EVIDENCE_MIN_WINS
        and int(stats.get("slates") or 0) >= EVIDENCE_MIN_SLATES
        and float(stats.get("net_units") or 0.0) > 0
    )


def _complete_prior_rows(rows: list[dict[str, Any]], target: date) -> list[dict[str, Any]]:
    prior = [
        row
        for row in rows
        if row.get("best_odds") is not None
        and row.get("best_book")
        and pregame_eligible(row)
        and (_iso(row.get("slate_date")) or target) < target
    ]
    by_slate: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in prior:
        by_slate[str(row.get("slate_date") or "")].append(row)
    complete = {
        slate
        for slate, values in by_slate.items()
        if values and not any(row.get("result") in {None, "PENDING"} for row in values)
    }
    return [row for row in prior if str(row.get("slate_date") or "") in complete]


def _window(rows: list[dict[str, Any]], target: date, days: int) -> list[dict[str, Any]]:
    start = target - timedelta(days=days)
    return [
        row
        for row in rows
        if (slate := _iso(row.get("slate_date"))) is not None and start <= slate < target
    ]


def _rows_for_cell(rows: list[dict[str, Any]], key: tuple[str, str, str]) -> list[dict[str, Any]]:
    return [row for row in rows if cell_key(row) == key]


def cell_public(
    key: tuple[str, str, str],
    evidence: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    checkpoint, book, form_id = key
    return {
        "checkpoint": checkpoint,
        "book": book,
        "form_id": form_id,
        "form": score_band_label(form_id),
        "label": f"{checkpoint} · {book} best price · {score_band_label(form_id)}",
        "evidence": evidence,
    }


def qualifying_cells(
    rows: Iterable[dict[str, Any]],
    target: date,
    checkpoint: str,
    available_keys: set[tuple[str, str, str]] | None = None,
) -> list[dict[str, Any]]:
    prior = _complete_prior_rows(list(rows), target)
    all_time = prior
    trailing_14 = _window(prior, target, 14)
    trailing_30 = _window(prior, target, 30)

    keys = sorted({
        key
        for row in all_time
        if (key := cell_key(row)) is not None
        and key[0] == checkpoint
        and (available_keys is None or key in available_keys)
    })

    output: list[dict[str, Any]] = []
    for key in keys:
        evidence = {
            "all_time": _summary(_rows_for_cell(all_time, key)),
            "trailing_30d": _summary(_rows_for_cell(trailing_30, key)),
            "trailing_14d": _summary(_rows_for_cell(trailing_14, key)),
        }
        all_stats = evidence["all_time"]
        month_stats = evidence["trailing_30d"]
        recent_stats = evidence["trailing_14d"]

        if not _evidence_gate(all_stats):
            continue
        if int(recent_stats.get("settled") or 0) < TRAILING_14_MIN_SETTLED:
            continue
        if float(recent_stats.get("roi") or 0.0) < TRAILING_14_MIN_ROI:
            continue
        if int(month_stats.get("settled") or 0) < TRAILING_30_MIN_SETTLED:
            continue
        if float(month_stats.get("net_units") or 0.0) <= 0:
            continue

        output.append(cell_public(key, evidence))

    output.sort(
        key=lambda item: (
            -float((item.get("evidence") or {}).get("trailing_14d", {}).get("roi") or 0.0),
            -int((item.get("evidence") or {}).get("trailing_14d", {}).get("settled") or 0),
            -float((item.get("evidence") or {}).get("all_time", {}).get("roi") or 0.0),
            item.get("label") or "",
        )
    )
    return output[:TOP_CELLS_PER_CHECKPOINT]


def _pick_from_row(row: dict[str, Any], cell: dict[str, Any], *, freeze: bool) -> dict[str, Any]:
    result = "PENDING" if freeze else str(row.get("result") or "PENDING")
    if freeze:
        profit = 0.0
        home_runs = None
    else:
        profit = float(row.get("profit_units") or 0.0) if result in {"WIN", "LOSS"} else 0.0
        home_runs = row.get("home_runs")
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
        "captured_at": row.get("captured_at") or row.get("captured_at_et"),
        "cell": {
            "checkpoint": cell.get("checkpoint"),
            "book": cell.get("book"),
            "form": cell.get("form"),
            "label": cell.get("label"),
            "evidence": cell.get("evidence"),
        },
        "result": result,
        "home_runs": home_runs,
        "profit_units": round(profit, 3),
    }


def select_checkpoint(
    rows: Iterable[dict[str, Any]],
    target: date,
    checkpoint: str,
    selected_ids: set[int] | None = None,
    *,
    freeze: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    values = list(rows)
    current = [
        row
        for row in values
        if str(row.get("slate_date") or "") == target.isoformat()
        and str(row.get("checkpoint") or "") == checkpoint
        and row.get("best_odds") is not None
        and row.get("best_book")
        and pregame_eligible(row)
    ]
    available = {key for row in current if (key := cell_key(row)) is not None}
    cells = qualifying_cells(values, target, checkpoint, available)
    by_key = {
        (str(cell["checkpoint"]), str(cell["book"]), str(cell["form_id"])): cell
        for cell in cells
    }
    selected_ids = selected_ids if selected_ids is not None else set()

    ordered = sorted(
        current,
        key=lambda row: (
            -float(row.get("score") or 0.0),
            -int(row.get("best_odds") or -999999),
            int(row.get("rank") or 999),
            str(row.get("player") or ""),
        ),
    )
    picks: list[dict[str, Any]] = []
    for row in ordered:
        try:
            player_id = int(row.get("mlbam_id"))
        except (TypeError, ValueError):
            continue
        if player_id in selected_ids:
            continue
        key = cell_key(row)
        cell = by_key.get(key) if key is not None else None
        if cell is None:
            continue
        picks.append(_pick_from_row(row, cell, freeze=freeze))
        selected_ids.add(player_id)
        if len(picks) >= MAX_PICKS_PER_CHECKPOINT:
            break
    return cells, picks


def _grade_pick(
    pick: dict[str, Any],
    lookup: dict[tuple[str, str, int], dict[str, Any]],
) -> dict[str, Any]:
    output = dict(pick)
    try:
        key = (
            str(pick.get("slate_date") or ""),
            str(pick.get("checkpoint") or ""),
            int(pick.get("mlbam_id")),
        )
    except (TypeError, ValueError):
        return output
    row = lookup.get(key)
    if row is None or row.get("result") not in {"WIN", "LOSS", "VOID"}:
        return output
    output["result"] = row["result"]
    output["home_runs"] = row.get("home_runs")
    if row["result"] == "VOID":
        output["profit_units"] = 0.0
    elif row["result"] == "LOSS":
        output["profit_units"] = -1.0
    else:
        output["profit_units"] = round(float(american_profit(output.get("odds")) or 0.0), 3)
    return output


def strategy_summary(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    values = list(rows)
    settled = [row for row in values if row.get("result") in {"WIN", "LOSS"}]
    wins = sum(row.get("result") == "WIN" for row in settled)
    net = sum(float(row.get("profit_units") or 0.0) for row in settled)
    daily: dict[str, float] = defaultdict(float)
    for row in settled:
        daily[str(row.get("slate_date") or "")] += float(row.get("profit_units") or 0.0)
    implied = [
        implied_probability(row.get("odds"))
        for row in settled
        if implied_probability(row.get("odds")) is not None
    ]
    hit_rate = wins / len(settled) if settled else None
    market_break_even = mean(implied) if implied else None
    return {
        "selections": len(values),
        "bets": len(settled),
        "wins": wins,
        "losses": len(settled) - wins,
        "voids": sum(row.get("result") == "VOID" for row in values),
        "pending": sum(row.get("result") in {None, "PENDING"} for row in values),
        "slates": len(daily),
        "profitable_slates": sum(value > 0 for value in daily.values()),
        "losing_slates": sum(value < 0 for value in daily.values()),
        "profitable_slate_rate": (
            sum(value > 0 for value in daily.values()) / len(daily) if daily else None
        ),
        "hit_rate": hit_rate,
        "average_break_even": market_break_even,
        "empirical_probability_edge": (
            hit_rate - market_break_even
            if hit_rate is not None and market_break_even is not None
            else None
        ),
        "net_units": round(net, 3),
        "roi": net / len(settled) if settled else None,
    }


def _daily_from_snapshots(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for snapshot in snapshots:
        grouped[str(snapshot.get("slate_date") or "")].append(snapshot)

    daily: list[dict[str, Any]] = []
    cumulative_bets = 0
    cumulative_wins = 0
    cumulative_units = 0.0
    for slate in sorted(grouped):
        day_snaps = sorted(
            grouped[slate],
            key=lambda row: CHECKPOINTS.index(str(row.get("checkpoint")))
            if str(row.get("checkpoint")) in CHECKPOINTS else 99,
        )
        selections = [pick for snap in day_snaps for pick in (snap.get("selections") or [])]
        stats = strategy_summary(selections)
        cumulative_bets += int(stats["bets"])
        cumulative_wins += int(stats["wins"])
        cumulative_units += float(stats["net_units"])
        daily.append({
            "slate_date": slate,
            "checkpoints": [snap.get("checkpoint") for snap in day_snaps],
            **stats,
            "selections": selections,
            "cumulative": {
                "bets": cumulative_bets,
                "wins": cumulative_wins,
                "losses": cumulative_bets - cumulative_wins,
                "net_units": round(cumulative_units, 3),
                "roi": cumulative_units / cumulative_bets if cumulative_bets else None,
            },
        })
    return daily


def backtest_range(
    rows: Iterable[dict[str, Any]],
    start: date,
    end: date,
) -> dict[str, Any]:
    values = list(rows)
    snapshots: list[dict[str, Any]] = []
    current = start
    while current <= end:
        selected_ids: set[int] = set()
        for checkpoint in CHECKPOINTS:
            cells, picks = select_checkpoint(
                values,
                current,
                checkpoint,
                selected_ids,
                freeze=False,
            )
            if cells or picks:
                snapshots.append({
                    "slate_date": current.isoformat(),
                    "checkpoint": checkpoint,
                    "mode": "dynamic_daily_backtest",
                    "qualified_cells": cells,
                    "selections": picks,
                })
        current += timedelta(days=1)

    daily = _daily_from_snapshots(snapshots)
    selections = [pick for snap in snapshots for pick in (snap.get("selections") or [])]
    return {
        "start": start.isoformat(),
        "through": end.isoformat(),
        "summary": strategy_summary(selections),
        "daily": daily,
        "snapshots": snapshots,
    }


def build_hr_dynamic_daily(
    annotated_rows: Iterable[dict[str, Any]],
    today: date,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows = list(annotated_rows)
    existing = existing or {}
    now = datetime.now(timezone.utc).isoformat()

    lookup: dict[tuple[str, str, int], dict[str, Any]] = {}
    for row in rows:
        try:
            lookup[(
                str(row.get("slate_date") or ""),
                str(row.get("checkpoint") or ""),
                int(row.get("mlbam_id")),
            )] = row
        except (TypeError, ValueError):
            continue

    snapshots = [
        dict(snapshot)
        for snapshot in ((existing.get("forward") or {}).get("snapshots") or [])
    ]
    for snapshot in snapshots:
        snapshot["selections"] = [
            _grade_pick(dict(pick), lookup)
            for pick in (snapshot.get("selections") or [])
        ]

    current_date = today.isoformat()
    existing_keys = {
        (str(snapshot.get("slate_date") or ""), str(snapshot.get("checkpoint") or ""))
        for snapshot in snapshots
    }
    selected_today_ids = {
        int(pick["mlbam_id"])
        for snapshot in snapshots
        if str(snapshot.get("slate_date") or "") == current_date
        for pick in (snapshot.get("selections") or [])
        if pick.get("mlbam_id") is not None
    }

    if today >= FORWARD_START:
        for checkpoint in CHECKPOINTS:
            cp_rows = [
                row
                for row in rows
                if str(row.get("slate_date") or "") == current_date
                and str(row.get("checkpoint") or "") == checkpoint
            ]
            if not cp_rows or (current_date, checkpoint) in existing_keys:
                continue
            cells, picks = select_checkpoint(
                rows,
                today,
                checkpoint,
                selected_today_ids,
                freeze=True,
            )
            captured_at = next(
                (
                    row.get("captured_at") or row.get("captured_at_et")
                    for row in cp_rows
                    if row.get("captured_at") or row.get("captured_at_et")
                ),
                now,
            )
            snapshots.append({
                "slate_date": current_date,
                "checkpoint": checkpoint,
                "mode": "dynamic_daily",
                "captured_at": captured_at,
                "qualified_cells": cells,
                "selections": picks,
            })
            existing_keys.add((current_date, checkpoint))

    for snapshot in snapshots:
        snapshot["selections"] = [
            _grade_pick(dict(pick), lookup)
            for pick in (snapshot.get("selections") or [])
        ]
    snapshots.sort(
        key=lambda row: (
            str(row.get("slate_date") or ""),
            CHECKPOINTS.index(str(row.get("checkpoint")))
            if str(row.get("checkpoint")) in CHECKPOINTS else 99,
        )
    )

    forward_daily = _daily_from_snapshots(snapshots)
    all_forward = [pick for snap in snapshots for pick in (snap.get("selections") or [])]
    current_snapshots = [
        snapshot for snapshot in snapshots
        if str(snapshot.get("slate_date") or "") == current_date
    ]
    current_picks = [
        pick for snapshot in current_snapshots for pick in (snapshot.get("selections") or [])
    ]

    development = backtest_range(rows, DEVELOPMENT_START, DEVELOPMENT_END)
    validation = backtest_range(rows, VALIDATION_START, min(VALIDATION_END, today))

    return {
        "schema_version": 1,
        "kind": "hr_dynamic_daily_picks",
        "status": "active" if today >= FORWARD_START else "research",
        "generated_at": now,
        "rule": {
            "name": "Dynamic Daily ROI",
            "checkpoints": list(CHECKPOINTS),
            "cell": "checkpoint × best-price sportsbook × HR Form band",
            "all_time_gate": (
                f"At least {EVIDENCE_MIN_SETTLED} settled bets, {EVIDENCE_MIN_WINS} wins, "
                f"{EVIDENCE_MIN_SLATES} slates, and positive net units."
            ),
            "trailing_30d_gate": (
                f"At least {TRAILING_30_MIN_SETTLED} settled bets and positive net units."
            ),
            "trailing_14d_gate": (
                f"At least {TRAILING_14_MIN_SETTLED} settled bets and ROI ≥ "
                f"{TRAILING_14_MIN_ROI:.0%}."
            ),
            "ranking": (
                f"Among qualifying cells represented on the current slate, rank by trailing-14-day "
                f"ROI and keep the top {TOP_CELLS_PER_CHECKPOINT} per checkpoint."
            ),
            "player_selection": (
                f"Within those cells, take the top {MAX_PICKS_PER_CHECKPOINT} players per checkpoint "
                f"by HR Form score, then archived best price. First qualifying checkpoint per player wins."
            ),
            "price_freeze": "Freeze the exact checkpoint sportsbook and price; never substitute a later quote.",
            "staking": "One flat unit per settled HR prop. No plate appearance is a void.",
        },
        "research": {
            "search_space": {
                "configurations_tested": 48384,
                "development_window": f"{DEVELOPMENT_START.isoformat()} through {DEVELOPMENT_END.isoformat()}",
                "untouched_validation_window": f"{VALIDATION_START.isoformat()} through {VALIDATION_END.isoformat()}",
                "top_100_development_selected_profitable_on_validation": 78,
                "top_100_validation_roi_median": 0.0522,
            },
            "note": (
                "Hyperparameters were selected on the development period only. "
                "September 12–25 was held out until after ranking."
            ),
            "development": development,
            "validation": validation,
        },
        "forward": {
            "start": FORWARD_START.isoformat(),
            "summary": strategy_summary(all_forward),
            "daily": forward_daily,
            "snapshots": snapshots,
        },
        "current": {
            "slate_date": current_date,
            "status": "live" if current_snapshots else "checkpoint_pending",
            "checkpoints": [
                {
                    "checkpoint": snapshot.get("checkpoint"),
                    "qualified_cells": snapshot.get("qualified_cells") or [],
                    "picks": snapshot.get("selections") or [],
                }
                for snapshot in current_snapshots
            ],
            "picks": current_picks,
        },
    }
