from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Iterable

from src.hr_picks import (
    CALIBRATION_END,
    CALIBRATION_START,
    FORWARD_START,
    PROMOTION_MIN_BETS,
    PROMOTION_MIN_PROFITABLE_SLATES,
    PROMOTION_MIN_SLATES,
    RETROSPECTIVE_END,
    RETROSPECTIVE_START,
    _between,
    _complete_slate_rows,
    american_profit,
    select_rule,
    strategy_summary,
)

CALIBRATION_SPLIT = date(2026, 8, 20)

VOLUME_RULE: dict[str, Any] = {
    "checkpoint": "1717",
    "form_id": "200p",
    "form_label": "0.200+",
    "odds_id": "u400",
    "odds_label": "Below +400",
    "book_id": "DK",
    "book_label": "DraftKings best price",
    "top_n": 10,
    "rule_id": "hr-volume-1717-200p-u400-DK-top10",
    "label": "1717 · 0.200+ · below +400 · DraftKings best price · top 10/slate",
}


def _stored_pick(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "slate_date": row.get("slate_date"),
        "checkpoint": row.get("checkpoint"),
        "mode": "companion",
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
        "result": "PENDING",
        "home_runs": None,
        "profit_units": 0.0,
    }


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


def _summary_rows(picks: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**pick, "best_odds": pick.get("odds")} for pick in picks]


def _promotion_pass(summary: dict[str, Any]) -> bool:
    return bool(
        int(summary.get("bets") or 0) >= PROMOTION_MIN_BETS
        and int(summary.get("slates") or 0) >= PROMOTION_MIN_SLATES
        and float(summary.get("roi") or 0.0) > 0
        and int(summary.get("profitable_slates") or 0) >= PROMOTION_MIN_PROFITABLE_SLATES
    )


def _daily(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    daily: list[dict[str, Any]] = []
    cumulative_bets = 0
    cumulative_wins = 0
    cumulative_units = 0.0
    for snapshot in sorted(snapshots, key=lambda row: str(row.get("slate_date") or "")):
        picks = list(snapshot.get("selections") or [])
        summary = strategy_summary(_summary_rows(picks))
        cumulative_bets += int(summary.get("bets") or 0)
        cumulative_wins += int(summary.get("wins") or 0)
        cumulative_units += float(summary.get("net_units") or 0.0)
        daily.append({
            "slate_date": snapshot.get("slate_date"),
            "checkpoint": snapshot.get("checkpoint"),
            "mode": "companion",
            "captured_at": snapshot.get("captured_at"),
            **summary,
            "selections": picks,
            "cumulative": {
                "bets": cumulative_bets,
                "wins": cumulative_wins,
                "losses": cumulative_bets - cumulative_wins,
                "net_units": round(cumulative_units, 3),
                "roi": cumulative_units / cumulative_bets if cumulative_bets else None,
            },
        })
    return daily


def _evidence(rows: list[dict[str, Any]], today: date) -> dict[str, Any]:
    complete = _complete_slate_rows(rows)
    calibration = _between(complete, CALIBRATION_START, CALIBRATION_END)
    early = [
        row for row in calibration
        if date.fromisoformat(str(row.get("slate_date"))) < CALIBRATION_SPLIT
    ]
    late = [
        row for row in calibration
        if date.fromisoformat(str(row.get("slate_date"))) >= CALIBRATION_SPLIT
    ]
    retro_through = min(today, RETROSPECTIVE_END)
    retrospective = (
        _between(complete, RETROSPECTIVE_START, retro_through)
        if retro_through >= RETROSPECTIVE_START else []
    )
    return {
        "calibration": {
            "start": CALIBRATION_START.isoformat(),
            "end": CALIBRATION_END.isoformat(),
            "split_date": CALIBRATION_SPLIT.isoformat(),
            "early": strategy_summary(select_rule(early, VOLUME_RULE)),
            "late": strategy_summary(select_rule(late, VOLUME_RULE)),
            "full": strategy_summary(select_rule(calibration, VOLUME_RULE)),
        },
        "retrospective": {
            "start": RETROSPECTIVE_START.isoformat(),
            "through": retro_through.isoformat(),
            "summary": strategy_summary(select_rule(retrospective, VOLUME_RULE)),
            "promotion_evidence": False,
            "note": "Diagnostic only; this period was visible before prospective tracking began.",
        },
    }


def build_hr_volume_companion(
    annotated_rows: Iterable[dict[str, Any]],
    today: date,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows = list(annotated_rows)
    existing = existing or {}
    now = datetime.now(timezone.utc).isoformat()

    existing_forward = existing.get("forward") or {}
    snapshots = [dict(snapshot) for snapshot in (existing_forward.get("snapshots") or [])]

    lookup: dict[tuple[str, str, int], dict[str, Any]] = {}
    for row in rows:
        try:
            key = (
                str(row.get("slate_date") or ""),
                str(row.get("checkpoint") or ""),
                int(row.get("mlbam_id")),
            )
        except (TypeError, ValueError):
            continue
        lookup[key] = row

    for snapshot in snapshots:
        snapshot["selections"] = [
            _grade_pick(dict(pick), lookup)
            for pick in (snapshot.get("selections") or [])
        ]

    current_date = today.isoformat()
    current_snapshot = next(
        (snapshot for snapshot in snapshots if snapshot.get("slate_date") == current_date),
        None,
    )
    has_checkpoint = any(
        str(row.get("slate_date") or "") == current_date
        and str(row.get("checkpoint") or "") == VOLUME_RULE["checkpoint"]
        for row in rows
    )

    if today >= FORWARD_START and current_snapshot is None and has_checkpoint:
        current_rows = [
            row for row in rows
            if str(row.get("slate_date") or "") == current_date
            and str(row.get("checkpoint") or "") == VOLUME_RULE["checkpoint"]
        ]
        selected = select_rule(current_rows, VOLUME_RULE)
        current_snapshot = {
            "slate_date": current_date,
            "checkpoint": VOLUME_RULE["checkpoint"],
            "mode": "companion",
            "captured_at": next(
                (
                    row.get("captured_at") or row.get("captured_at_et")
                    for row in current_rows
                    if row.get("captured_at") or row.get("captured_at_et")
                ),
                now,
            ),
            "rule_id": VOLUME_RULE["rule_id"],
            "selections": [_stored_pick(row) for row in selected],
        }
        snapshots.append(current_snapshot)

    for snapshot in snapshots:
        snapshot["selections"] = [
            _grade_pick(dict(pick), lookup)
            for pick in (snapshot.get("selections") or [])
        ]

    all_picks = [
        pick
        for snapshot in snapshots
        for pick in (snapshot.get("selections") or [])
    ]
    summary = strategy_summary(_summary_rows(all_picks))
    promoted_at = existing_forward.get("promoted_at")
    if promoted_at is None and _promotion_pass(summary):
        promoted_at = today.isoformat()

    current_snapshot = next(
        (snapshot for snapshot in snapshots if snapshot.get("slate_date") == current_date),
        None,
    )
    if current_snapshot is None:
        current_status = "checkpoint_pending" if today >= FORWARD_START else "forward_not_started"
        current_picks: list[dict[str, Any]] = []
    else:
        current_status = "active"
        current_picks = list(current_snapshot.get("selections") or [])

    evidence = _evidence(rows, today)
    return {
        "schema_version": 1,
        "kind": "hr_form_volume_companion",
        "status": "active",
        "generated_at": now,
        "rule": {
            **VOLUME_RULE,
            "frozen_for_forward_tracking": True,
        },
        "methodology": {
            "selection": "At 17:17 ET, select score >=0.200 candidates whose archived best price is DraftKings and is below +400; rank by score then price and take up to 10.",
            "freeze": "The exact archived 17:17 DraftKings price is frozen once. Later price movement never replaces the wager.",
            "staking": "One flat unit per settled HR prop; no plate appearance is a void.",
            "forward": f"Prospective tracking begins {FORWARD_START.isoformat()} and is independent from the primary rule.",
        },
        **evidence,
        "promotion_gate": {
            "passed": promoted_at is not None,
            "requirements": {
                "min_settled_bets": PROMOTION_MIN_BETS,
                "min_betting_slates": PROMOTION_MIN_SLATES,
                "positive_roi": True,
                "min_profitable_slates": PROMOTION_MIN_PROFITABLE_SLATES,
            },
            "promoted_at": promoted_at,
        },
        "forward": {
            "start": FORWARD_START.isoformat(),
            "promoted_at": promoted_at,
            "summary": summary,
            "daily": _daily(snapshots),
            "snapshots": sorted(snapshots, key=lambda row: str(row.get("slate_date") or "")),
        },
        "current": {
            "slate_date": current_date,
            "checkpoint": VOLUME_RULE["checkpoint"],
            "status": current_status,
            "picks": current_picks,
        },
    }


def build_combined_portfolio(
    primary: dict[str, Any],
    companion: dict[str, Any],
) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    flattened: list[dict[str, Any]] = []
    for strategy, payload in (("primary", primary), ("companion", companion)):
        for snapshot in (payload.get("forward") or {}).get("snapshots") or []:
            for pick in snapshot.get("selections") or []:
                flattened.append({**pick, "strategy": strategy})

    # The fixed rules use disjoint score bands, so overlap should be zero. Keep a
    # defensive player/slate de-duplication rule so the portfolio never double-stakes
    # the same HR prop if a future rule edit accidentally creates overlap.
    deduped: dict[tuple[str, int], dict[str, Any]] = {}
    overlap_deduped = 0
    for pick in sorted(flattened, key=lambda row: 0 if row.get("strategy") == "primary" else 1):
        try:
            key = (str(pick.get("slate_date") or ""), int(pick.get("mlbam_id")))
        except (TypeError, ValueError):
            continue
        if key in deduped:
            overlap_deduped += 1
            continue
        deduped[key] = pick

    all_picks = sorted(
        deduped.values(),
        key=lambda row: (
            str(row.get("slate_date") or ""),
            str(row.get("checkpoint") or ""),
            int(row.get("rank") or 999),
            str(row.get("player") or ""),
        ),
    )

    by_day: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for pick in all_picks:
        by_day[str(pick.get("slate_date") or "")].append(pick)

    daily: list[dict[str, Any]] = []
    cumulative_bets = 0
    cumulative_wins = 0
    cumulative_units = 0.0
    for slate in sorted(by_day):
        picks = by_day[slate]
        summary = strategy_summary(_summary_rows(picks))
        cumulative_bets += int(summary.get("bets") or 0)
        cumulative_wins += int(summary.get("wins") or 0)
        cumulative_units += float(summary.get("net_units") or 0.0)
        daily.append({
            "slate_date": slate,
            "mode": "combined",
            "sources": {
                "primary": sum(pick.get("strategy") == "primary" for pick in picks),
                "companion": sum(pick.get("strategy") == "companion" for pick in picks),
            },
            **summary,
            "selections": picks,
            "cumulative": {
                "bets": cumulative_bets,
                "wins": cumulative_wins,
                "losses": cumulative_bets - cumulative_wins,
                "net_units": round(cumulative_units, 3),
                "roi": cumulative_units / cumulative_bets if cumulative_bets else None,
            },
        })

    current_date = (
        (primary.get("current") or {}).get("slate_date")
        or (companion.get("current") or {}).get("slate_date")
    )
    current_picks = [
        pick for pick in all_picks
        if str(pick.get("slate_date") or "") == str(current_date or "")
    ]
    summary = strategy_summary(_summary_rows(all_picks))
    return {
        "schema_version": 1,
        "kind": "hr_form_combined_portfolio",
        "status": "active",
        "generated_at": now,
        "methodology": {
            "definition": "Union of the independently frozen Primary / Selective and Companion / Volume rules.",
            "staking": "One flat unit per unique player HR prop.",
            "dedupe": "If the same player ever appears in both strategies on the same slate, count it once in the combined portfolio with primary precedence.",
        },
        "overlap_deduped": overlap_deduped,
        "forward": {
            "start": FORWARD_START.isoformat(),
            "summary": summary,
            "daily": daily,
        },
        "current": {
            "slate_date": current_date,
            "status": "active" if current_picks else "checkpoint_pending",
            "picks": current_picks,
        },
    }
