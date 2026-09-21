from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

CHECKPOINTS = ("0817", "1117", "1717", "2017")
FORWARD_START = date(2026, 9, 21)

EVIDENCE_MIN_SETTLED = 40
EVIDENCE_MIN_WINS = 4
EVIDENCE_MIN_SLATES = 5
SUPPORT_MIN_SETTLED = 20
SUPPORT_MIN_SLATES = 5

SCORE_BANDS = (
    ("400p", "0.400+"),
    ("300_399", "0.300–0.399"),
    ("200_299", "0.200–0.299"),
    ("100_199", "0.100–0.199"),
    ("u100", "Below 0.100"),
)
ODDS_BANDS = (
    ("u400", "Below +400"),
    ("400_499", "+400 to +499"),
    ("500_599", "+500 to +599"),
    ("600_799", "+600 to +799"),
    ("800_999", "+800 to +999"),
    ("1000p", "+1000 or longer"),
)


def american_profit(odds: int | float | None) -> float | None:
    if odds is None:
        return None
    value = float(odds)
    if value == 0:
        return None
    return value / 100.0 if value > 0 else 100.0 / abs(value)


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


def pregame_eligible(row: dict[str, Any]) -> bool:
    if row.get("game_started_at_checkpoint") is True:
        return False
    captured = _instant(row.get("captured_at") or row.get("captured_at_et"))
    starts = _instant(row.get("game_start_at"))
    return not (captured is not None and starts is not None and captured >= starts)


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


def odds_band_id(odds: int) -> str:
    if odds < 400:
        return "u400"
    if odds < 500:
        return "400_499"
    if odds < 600:
        return "500_599"
    if odds < 800:
        return "600_799"
    if odds < 1000:
        return "800_999"
    return "1000p"


def _label(pairs: tuple[tuple[str, str], ...], key: str) -> str:
    return next((label for value, label in pairs if value == key), key)


def cell_key(row: dict[str, Any]) -> tuple[str, str, str] | None:
    if row.get("best_odds") is None:
        return None
    try:
        return (
            str(row.get("checkpoint") or ""),
            score_band_id(float(row.get("score") or 0.0)),
            odds_band_id(int(row["best_odds"])),
        )
    except (TypeError, ValueError):
        return None


def cell_public(key: tuple[str, str, str]) -> dict[str, str]:
    checkpoint, form_id, odds_id = key
    return {
        "checkpoint": checkpoint,
        "form_id": form_id,
        "form": _label(SCORE_BANDS, form_id),
        "odds_id": odds_id,
        "odds": _label(ODDS_BANDS, odds_id),
        "label": f"{checkpoint} · {_label(SCORE_BANDS, form_id)} · {_label(ODDS_BANDS, odds_id)}",
    }


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


def _support_gate(stats: dict[str, Any]) -> bool:
    return bool(
        int(stats.get("settled") or 0) >= SUPPORT_MIN_SETTLED
        and int(stats.get("slates") or 0) >= SUPPORT_MIN_SLATES
        and float(stats.get("net_units") or 0.0) > 0
    )


def _complete_prior_rows(rows: list[dict[str, Any]], target: date) -> list[dict[str, Any]]:
    prior = [
        row for row in rows
        if row.get("best_odds") is not None
        and (_iso(row.get("slate_date")) or target) < target
    ]
    by_slate: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in prior:
        by_slate[str(row.get("slate_date") or "")].append(row)
    complete = {
        slate for slate, values in by_slate.items()
        if values and not any(row.get("result") in {None, "PENDING"} for row in values)
    }
    return [row for row in prior if str(row.get("slate_date") or "") in complete]


def _window(rows: list[dict[str, Any]], target: date, days: int | None) -> list[dict[str, Any]]:
    if days is None:
        return rows
    start = target - timedelta(days=days)
    return [
        row for row in rows
        if (slate := _iso(row.get("slate_date"))) is not None and start <= slate < target
    ]


def _rows_for_cell(rows: list[dict[str, Any]], key: tuple[str, str, str]) -> list[dict[str, Any]]:
    return [row for row in rows if cell_key(row) == key]


def _parent_support(rows: list[dict[str, Any]], key: tuple[str, str, str]) -> dict[str, Any]:
    checkpoint, form_id, odds_id = key
    groups = {
        "checkpoint_x_form": [
            row for row in rows
            if str(row.get("checkpoint") or "") == checkpoint
            and cell_key(row) is not None
            and cell_key(row)[1] == form_id
        ],
        "checkpoint_x_odds": [
            row for row in rows
            if str(row.get("checkpoint") or "") == checkpoint
            and cell_key(row) is not None
            and cell_key(row)[2] == odds_id
        ],
        "form_x_odds": [
            row for row in rows
            if cell_key(row) is not None
            and cell_key(row)[1] == form_id
            and cell_key(row)[2] == odds_id
        ],
    }
    summaries = {name: _summary(values) for name, values in groups.items()}
    passing = [name for name, stats in summaries.items() if _support_gate(stats)]
    return {
        "passing": len(passing),
        "required": 2,
        "passed": len(passing) >= 2,
        "details": summaries,
    }


def qualifying_cells(
    rows: Iterable[dict[str, Any]],
    target: date,
    checkpoint: str,
) -> list[dict[str, Any]]:
    prior = _complete_prior_rows(list(rows), target)
    horizons = {
        "all_time": _window(prior, target, None),
        "trailing_30d": _window(prior, target, 30),
        "trailing_14d": _window(prior, target, 14),
    }
    keys = sorted({
        key for row in horizons["all_time"]
        if (key := cell_key(row)) is not None and key[0] == checkpoint
    })
    output: list[dict[str, Any]] = []
    for key in keys:
        evidence = {
            name: _summary(_rows_for_cell(window_rows, key))
            for name, window_rows in horizons.items()
        }
        if not all(_evidence_gate(stats) for stats in evidence.values()):
            continue
        total_bets = sum(int(stats["settled"]) for stats in evidence.values())
        weighted_roi = (
            sum(float(stats["net_units"]) for stats in evidence.values()) / total_bets
            if total_bets else None
        )
        if weighted_roi is None or weighted_roi <= 0:
            continue
        support = _parent_support(horizons["all_time"], key)
        if not support["passed"]:
            continue
        output.append({
            **cell_public(key),
            "evidence": evidence,
            "weighted_expected_return": weighted_roi,
            "support": support,
        })
    output.sort(
        key=lambda item: (
            -float(item.get("weighted_expected_return") or 0.0),
            -float((item.get("evidence") or {}).get("trailing_14d", {}).get("net_units") or 0.0),
            item.get("label") or "",
        )
    )
    return output


def _stored_pick(row: dict[str, Any], cell: dict[str, Any]) -> dict[str, Any]:
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
            "form": cell.get("form"),
            "odds": cell.get("odds"),
            "label": cell.get("label"),
        },
        "result": "PENDING",
        "home_runs": None,
        "profit_units": 0.0,
    }


def _grade_pick(pick: dict[str, Any], lookup: dict[tuple[str, str, int], dict[str, Any]]) -> dict[str, Any]:
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
    return {
        "selections": len(values),
        "bets": len(settled),
        "wins": wins,
        "losses": len(settled) - wins,
        "voids": sum(row.get("result") == "VOID" for row in values),
        "pending": sum(row.get("result") in {None, "PENDING"} for row in values),
        "slates": len(daily),
        "profitable_slates": sum(value > 0 for value in daily.values()),
        "hit_rate": wins / len(settled) if settled else None,
        "net_units": round(net, 3),
        "roi": net / len(settled) if settled else None,
    }


def _daily(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for snapshot in snapshots:
        grouped[str(snapshot.get("slate_date") or "")].append(snapshot)
    daily = []
    cumulative_bets = 0
    cumulative_wins = 0
    cumulative_units = 0.0
    for slate in sorted(grouped):
        day_snapshots = sorted(
            grouped[slate],
            key=lambda row: CHECKPOINTS.index(str(row.get("checkpoint")))
            if str(row.get("checkpoint")) in CHECKPOINTS else 99,
        )
        selections = [pick for snap in day_snapshots for pick in (snap.get("selections") or [])]
        summary = strategy_summary(selections)
        cumulative_bets += int(summary["bets"])
        cumulative_wins += int(summary["wins"])
        cumulative_units += float(summary["net_units"])
        daily.append({
            "slate_date": slate,
            "checkpoints": [snap.get("checkpoint") for snap in day_snapshots],
            **summary,
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


def build_hr_companion(
    annotated_rows: Iterable[dict[str, Any]],
    today: date,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows = list(annotated_rows)
    existing = existing or {}
    snapshots = [
        dict(snapshot)
        for snapshot in ((existing.get("forward") or {}).get("snapshots") or [])
    ]
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

    for snapshot in snapshots:
        snapshot["selections"] = [
            _grade_pick(dict(pick), lookup)
            for pick in (snapshot.get("selections") or [])
        ]

    current_date = today.isoformat()
    today_rows = [row for row in rows if str(row.get("slate_date") or "") == current_date]
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
                row for row in today_rows
                if str(row.get("checkpoint") or "") == checkpoint
            ]
            if not cp_rows or (current_date, checkpoint) in existing_keys:
                continue
            cells = qualifying_cells(rows, today, checkpoint)
            by_key = {
                (str(cell["checkpoint"]), str(cell["form_id"]), str(cell["odds_id"])): cell
                for cell in cells
            }
            selections: list[dict[str, Any]] = []
            ordered = sorted(
                cp_rows,
                key=lambda row: (
                    -float(row.get("score") or 0.0),
                    -int(row.get("best_odds") or -999999),
                    int(row.get("rank") or 999),
                    str(row.get("player") or ""),
                ),
            )
            for row in ordered:
                if not pregame_eligible(row):
                    continue
                try:
                    player_id = int(row.get("mlbam_id"))
                except (TypeError, ValueError):
                    continue
                if player_id in selected_today_ids:
                    continue
                key = cell_key(row)
                cell = by_key.get(key) if key is not None else None
                if cell is None:
                    continue
                selections.append(_stored_pick(row, cell))
                selected_today_ids.add(player_id)
            captured_at = next(
                (
                    row.get("captured_at") or row.get("captured_at_et")
                    for row in cp_rows
                    if row.get("captured_at") or row.get("captured_at_et")
                ),
                datetime.now(timezone.utc).isoformat(),
            )
            snapshots.append({
                "slate_date": current_date,
                "checkpoint": checkpoint,
                "mode": "companion",
                "captured_at": captured_at,
                "qualified_cells": cells,
                "selections": selections,
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
            str(row.get("checkpoint") or ""),
        )
    )
    all_picks = [
        pick
        for snapshot in snapshots
        for pick in (snapshot.get("selections") or [])
    ]
    daily = _daily(snapshots)
    current_snapshots = [
        snapshot for snapshot in snapshots
        if str(snapshot.get("slate_date") or "") == current_date
    ]
    current_picks = [
        pick
        for snapshot in current_snapshots
        for pick in (snapshot.get("selections") or [])
    ]

    return {
        "schema_version": 1,
        "kind": "hr_form_companion",
        "status": "active" if today >= FORWARD_START else "not_started",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "rule": {
            "name": "Dynamic evidence-gated companion",
            "checkpoints": list(CHECKPOINTS),
            "trigger": "Checkpoint × HR Form band × odds band",
            "selection_cap": None,
            "freeze": (
                "First qualifying checkpoint per player per slate; exact archived book "
                "and price are immutable."
            ),
        },
        "methodology": {
            "history": (
                "Every checkpoint uses only complete, prior settled slates; the current "
                "slate never contributes to its own rule selection."
            ),
            "evidence_gate": (
                f"Each trigger cell must independently clear all-history, trailing-30-day, "
                f"and trailing-14-day gates of at least {EVIDENCE_MIN_SETTLED} settled bets, "
                f"{EVIDENCE_MIN_WINS} wins, {EVIDENCE_MIN_SLATES} slates, and positive net units."
            ),
            "weighted_return": (
                "Expected return is the settled-bet-weighted ROI across the three evidence "
                "horizons and must remain positive."
            ),
            "support": (
                f"At least two of three broader parent slices (checkpoint × form, checkpoint × odds, "
                f"form × odds) must each have at least {SUPPORT_MIN_SETTLED} settled bets, "
                f"{SUPPORT_MIN_SLATES} slates, and positive net units in prior history."
            ),
            "execution": (
                "Select every pregame player in a qualifying broad trigger cell. Book, rank, "
                "and game-time slices are supporting diagnostics only and never trigger a bet "
                "by themselves. If a player qualifies more than once, the first checkpoint wins."
            ),
            "staking": "One flat unit per settled HR prop. No plate appearance is a void.",
        },
        "forward": {
            "start": FORWARD_START.isoformat(),
            "summary": strategy_summary(all_picks),
            "daily": daily,
            "snapshots": snapshots,
        },
        "current": {
            "slate_date": current_date,
            "status": (
                "live" if current_snapshots
                else ("checkpoint_pending" if today >= FORWARD_START else "not_started")
            ),
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
