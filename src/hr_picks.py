from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any, Iterable

CHECKPOINTS = ("0817", "1117", "1717", "2017")
CALIBRATION_START = date(2026, 8, 4)
CALIBRATION_END = date(2026, 9, 5)
RETROSPECTIVE_START = date(2026, 9, 6)
RETROSPECTIVE_END = date(2026, 9, 20)
FORWARD_START = date(2026, 9, 21)
HR_ET = ZoneInfo("America/New_York")

PROMOTION_MIN_BETS = 20
PROMOTION_MIN_SLATES = 5
PROMOTION_MIN_PROFITABLE_SLATES = 3

FORM_RULES = (
    ("all", "All scores"),
    ("100_199", "0.100–0.199"),
    ("200_299", "0.200–0.299"),
    ("300_399", "0.300–0.399"),
    ("400p", "0.400+"),
    ("100p", "0.100+"),
    ("200p", "0.200+"),
    ("300p", "0.300+"),
)

ODDS_RULES = (
    ("all", "All odds"),
    ("u400", "Below +400"),
    ("400_499", "+400–499"),
    ("500_599", "+500–599"),
    ("600_799", "+600–799"),
    ("800_999", "+800–999"),
    ("1000p", "+1000+"),
    ("400_599", "+400–599"),
    ("400_799", "+400–799"),
    ("500_799", "+500–799"),
    ("600_999", "+600–999"),
    ("400p", "+400+"),
    ("500p", "+500+"),
    ("600p", "+600+"),
)

BOOK_RULES = (
    ("all", "Any best-price book"),
    ("FD", "FanDuel"),
    ("DK", "DraftKings"),
    ("MGM", "BetMGM"),
)

TOP_NS = (1, 2, 3, 5, 8, 10)


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


def wilson_lower(wins: int, n: int, z: float = 1.6448536269514722) -> float | None:
    if n <= 0:
        return None
    p = wins / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = p + z2 / (2.0 * n)
    spread = z * ((p * (1.0 - p) + z2 / (4.0 * n)) / n) ** 0.5
    return (center - spread) / denom


def _iso_date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _instant(value: Any) -> datetime | None:
    if not value:
        return None
    raw = str(value).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
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
    if captured is not None and starts is not None and captured >= starts:
        return False
    return True


def form_match(score: float, rule_id: str) -> bool:
    if rule_id == "all":
        return True
    if rule_id == "100_199":
        return 0.1 <= score < 0.2
    if rule_id == "200_299":
        return 0.2 <= score < 0.3
    if rule_id == "300_399":
        return 0.3 <= score < 0.4
    if rule_id == "400p":
        return score >= 0.4
    if rule_id == "100p":
        return score >= 0.1
    if rule_id == "200p":
        return score >= 0.2
    if rule_id == "300p":
        return score >= 0.3
    return False


def odds_match(odds: int, rule_id: str) -> bool:
    if rule_id == "all":
        return True
    if rule_id == "u400":
        return odds < 400
    if rule_id == "400_499":
        return 400 <= odds < 500
    if rule_id == "500_599":
        return 500 <= odds < 600
    if rule_id == "600_799":
        return 600 <= odds < 800
    if rule_id == "800_999":
        return 800 <= odds < 1000
    if rule_id == "1000p":
        return odds >= 1000
    if rule_id == "400_599":
        return 400 <= odds < 600
    if rule_id == "400_799":
        return 400 <= odds < 800
    if rule_id == "500_799":
        return 500 <= odds < 800
    if rule_id == "600_999":
        return 600 <= odds < 1000
    if rule_id == "400p":
        return odds >= 400
    if rule_id == "500p":
        return odds >= 500
    if rule_id == "600p":
        return odds >= 600
    return False


def book_match(book: str | None, rule_id: str) -> bool:
    if rule_id == "all":
        return True
    expected = {"FD": "FanDuel", "DK": "DraftKings", "MGM": "BetMGM"}.get(rule_id)
    return expected is not None and str(book or "") == expected


def rule_label(rule: dict[str, Any]) -> str:
    return (
        f"{rule['checkpoint']} · {rule['form_label']} · {rule['odds_label']} · "
        f"{rule['book_label']} · top {rule['top_n']}/slate"
    )


def rule_id(rule: dict[str, Any]) -> str:
    return (
        f"hr-grid-{rule['checkpoint']}-{rule['form_id']}-{rule['odds_id']}-"
        f"{rule['book_id']}-top{rule['top_n']}"
    )


def candidate_grid() -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for checkpoint in CHECKPOINTS:
        for form_id, form_label in FORM_RULES:
            for odds_id, odds_label in ODDS_RULES:
                for book_id, book_label in BOOK_RULES:
                    for top_n in TOP_NS:
                        rule = {
                            "checkpoint": checkpoint,
                            "form_id": form_id,
                            "form_label": form_label,
                            "odds_id": odds_id,
                            "odds_label": odds_label,
                            "book_id": book_id,
                            "book_label": book_label,
                            "top_n": top_n,
                        }
                        rule["rule_id"] = rule_id(rule)
                        rule["label"] = rule_label(rule)
                        output.append(rule)
    return output


def row_matches_rule(row: dict[str, Any], rule: dict[str, Any]) -> bool:
    if str(row.get("checkpoint") or "") != str(rule.get("checkpoint") or ""):
        return False
    if row.get("best_odds") is None:
        return False
    try:
        score = float(row.get("score") or 0.0)
        odds = int(row["best_odds"])
    except (TypeError, ValueError):
        return False
    return (
        pregame_eligible(row)
        and form_match(score, str(rule["form_id"]))
        and odds_match(odds, str(rule["odds_id"]))
        and book_match(row.get("best_book"), str(rule["book_id"]))
    )


def select_rule(rows: Iterable[dict[str, Any]], rule: dict[str, Any]) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row_matches_rule(row, rule):
            buckets[str(row.get("slate_date") or "")].append(row)

    selected: list[dict[str, Any]] = []
    for slate in sorted(buckets):
        values = buckets[slate]
        values.sort(
            key=lambda row: (
                -float(row.get("score") or 0.0),
                -int(row.get("best_odds") or -999999),
                int(row.get("rank") or 999),
                str(row.get("player") or ""),
            )
        )
        selected.extend(values[: int(rule["top_n"])])
    return selected


def strategy_summary(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    values = list(rows)
    settled = [row for row in values if row.get("result") in {"WIN", "LOSS"}]
    wins = sum(row.get("result") == "WIN" for row in settled)
    losses = len(settled) - wins
    net_units = sum(float(row.get("profit_units") or 0.0) for row in settled)
    implied = [
        implied_probability(row.get("best_odds") if row.get("best_odds") is not None else row.get("odds"))
        for row in settled
    ]
    usable_implied = [value for value in implied if value is not None]
    average_break_even = (
        sum(usable_implied) / len(usable_implied) if usable_implied else None
    )
    hit_rate = wins / len(settled) if settled else None

    daily: dict[str, float] = defaultdict(float)
    for row in settled:
        daily[str(row.get("slate_date") or "")] += float(row.get("profit_units") or 0.0)
    daily_values = list(daily.values())
    positive = [value for value in daily_values if value > 0]
    positive_gross = sum(positive)
    max_positive = max(positive) if positive else 0.0

    return {
        "selections": len(values),
        "bets": len(settled),
        "wins": wins,
        "losses": losses,
        "voids": sum(row.get("result") == "VOID" for row in values),
        "pending": sum(row.get("result") in {None, "PENDING"} for row in values),
        "slates": len(daily),
        "profitable_slates": len(positive),
        "losing_slates": sum(value < 0 for value in daily_values),
        "flat_slates": sum(value == 0 for value in daily_values),
        "profitable_slate_rate": len(positive) / len(daily) if daily else None,
        "hit_rate": hit_rate,
        "average_break_even": average_break_even,
        "empirical_probability_edge": (
            hit_rate - average_break_even
            if hit_rate is not None and average_break_even is not None
            else None
        ),
        "lower90_hit_rate": wilson_lower(wins, len(settled)),
        "net_units": round(net_units, 3),
        "roi": net_units / len(settled) if settled else None,
        "max_positive_day_share": (
            max_positive / positive_gross if positive_gross > 0 else None
        ),
    }


def _complete_slate_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    priced = [row for row in rows if row.get("best_odds") is not None]
    by_slate: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in priced:
        by_slate[str(row.get("slate_date") or "")].append(row)
    complete = {
        slate
        for slate, values in by_slate.items()
        if values and not any(row.get("result") in {None, "PENDING"} for row in values)
    }
    return [row for row in priced if str(row.get("slate_date") or "") in complete]


def _dates(rows: Iterable[dict[str, Any]]) -> list[str]:
    return sorted({str(row.get("slate_date")) for row in rows if row.get("slate_date")})


def _between(rows: Iterable[dict[str, Any]], start: date, end: date) -> list[dict[str, Any]]:
    output = []
    for row in rows:
        slate = _iso_date(row.get("slate_date"))
        if slate is not None and start <= slate <= end:
            output.append(row)
    return output


def _calibration_pass(early: dict[str, Any], late: dict[str, Any], full: dict[str, Any]) -> bool:
    if early["bets"] < 12 or early["slates"] < 8:
        return False
    if late["bets"] < 12 or late["slates"] < 8:
        return False
    if full["bets"] < 30 or full["slates"] < 16:
        return False

    for stats in (early, late, full):
        if not (float(stats.get("roi") or 0.0) > 0):
            return False
        if not (float(stats.get("empirical_probability_edge") or 0.0) > 0):
            return False

    lower = full.get("lower90_hit_rate")
    break_even = full.get("average_break_even")
    if lower is None or break_even is None or not (lower > break_even):
        return False

    if float(early.get("profitable_slate_rate") or 0.0) < 0.25:
        return False
    if float(late.get("profitable_slate_rate") or 0.0) < 0.25:
        return False
    if int(full.get("profitable_slates") or 0) < 8:
        return False

    if float(early.get("max_positive_day_share") or 1.0) > 0.50:
        return False
    if float(late.get("max_positive_day_share") or 1.0) > 0.50:
        return False
    if float(full.get("max_positive_day_share") or 1.0) > 0.40:
        return False
    return True


def _calibration_score(early: dict[str, Any], late: dict[str, Any], full: dict[str, Any]) -> float:
    min_edge = min(
        float(early.get("empirical_probability_edge") or 0.0),
        float(late.get("empirical_probability_edge") or 0.0),
    )
    min_roi = min(float(early.get("roi") or 0.0), float(late.get("roi") or 0.0))
    stability = abs(float(early.get("roi") or 0.0) - float(late.get("roi") or 0.0))
    stability += 2.0 * abs(
        float(early.get("empirical_probability_edge") or 0.0)
        - float(late.get("empirical_probability_edge") or 0.0)
    )
    sample_bonus = min(0.08, __import__("math").log1p(int(full.get("bets") or 0)) / 80.0)
    return (
        2.0 * min_edge
        + 0.45 * min_roi
        + 0.25 * float(full.get("roi") or 0.0)
        + 0.20 * float(full.get("profitable_slate_rate") or 0.0)
        + sample_bonus
        - 0.15 * stability
    )


def discover_rule(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    complete = _complete_slate_rows(list(rows))
    calibration = _between(complete, CALIBRATION_START, CALIBRATION_END)
    recovered_dates = _dates(calibration)
    if len(recovered_dates) < 2:
        return {
            "ready": False,
            "reason": "Not enough complete calibration slates.",
            "candidates_tested": 0,
            "passing_candidates": 0,
            "split_date": None,
            "winner": None,
            "top_candidates": [],
        }

    split_date = recovered_dates[len(recovered_dates) // 2]
    early = [row for row in calibration if str(row.get("slate_date")) < split_date]
    late = [row for row in calibration if str(row.get("slate_date")) >= split_date]
    early_by_checkpoint = {
        checkpoint: [row for row in early if str(row.get("checkpoint") or "") == checkpoint]
        for checkpoint in CHECKPOINTS
    }
    late_by_checkpoint = {
        checkpoint: [row for row in late if str(row.get("checkpoint") or "") == checkpoint]
        for checkpoint in CHECKPOINTS
    }
    calibration_by_checkpoint = {
        checkpoint: [row for row in calibration if str(row.get("checkpoint") or "") == checkpoint]
        for checkpoint in CHECKPOINTS
    }

    passing: list[dict[str, Any]] = []
    grid = candidate_grid()
    for rule in grid:
        checkpoint = str(rule["checkpoint"])
        early_summary = strategy_summary(select_rule(early_by_checkpoint[checkpoint], rule))
        late_summary = strategy_summary(select_rule(late_by_checkpoint[checkpoint], rule))
        full_summary = strategy_summary(select_rule(calibration_by_checkpoint[checkpoint], rule))
        if not _calibration_pass(early_summary, late_summary, full_summary):
            continue
        score = _calibration_score(early_summary, late_summary, full_summary)
        passing.append({
            "rule": rule,
            "score": round(score, 6),
            "early": early_summary,
            "late": late_summary,
            "full": full_summary,
        })

    passing.sort(
        key=lambda row: (
            -float(row["score"]),
            -float(row["full"].get("net_units") or 0.0),
            -int(row["full"].get("bets") or 0),
            str(row["rule"].get("rule_id") or ""),
        )
    )
    winner = passing[0] if passing else None
    return {
        "ready": winner is not None,
        "reason": (
            "Stable calibration rule found."
            if winner is not None
            else "No candidate cleared the stability and market-edge guardrails."
        ),
        "candidates_tested": len(grid),
        "passing_candidates": len(passing),
        "split_date": split_date,
        "recovered_dates": recovered_dates,
        "winner": winner,
        "top_candidates": passing[:12],
    }


def _stored_pick(row: dict[str, Any], mode: str) -> dict[str, Any]:
    return {
        "slate_date": row.get("slate_date"),
        "checkpoint": row.get("checkpoint"),
        "mode": mode,
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
    if row is None:
        return output
    result = row.get("result")
    if result not in {"WIN", "LOSS", "VOID"}:
        return output
    output["result"] = result
    output["home_runs"] = row.get("home_runs")
    if result == "VOID":
        output["profit_units"] = 0.0
    elif result == "LOSS":
        output["profit_units"] = -1.0
    else:
        output["profit_units"] = round(float(american_profit(output.get("odds")) or 0.0), 3)
    return output


def _forward_daily(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    daily: list[dict[str, Any]] = []
    cumulative_bets = 0
    cumulative_wins = 0
    cumulative_units = 0.0
    for snapshot in sorted(snapshots, key=lambda row: str(row.get("slate_date") or "")):
        selections = list(snapshot.get("selections") or [])
        summary = strategy_summary([
            {
                **pick,
                "best_odds": pick.get("odds"),
            }
            for pick in selections
        ])
        cumulative_bets += int(summary["bets"])
        cumulative_wins += int(summary["wins"])
        cumulative_units += float(summary["net_units"])
        daily.append({
            "slate_date": snapshot.get("slate_date"),
            "checkpoint": snapshot.get("checkpoint"),
            "mode": snapshot.get("mode"),
            "captured_at": snapshot.get("captured_at"),
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


def _promotion_pass(summary: dict[str, Any]) -> bool:
    return bool(
        int(summary.get("bets") or 0) >= PROMOTION_MIN_BETS
        and int(summary.get("slates") or 0) >= PROMOTION_MIN_SLATES
        and float(summary.get("roi") or 0.0) > 0
        and int(summary.get("profitable_slates") or 0) >= PROMOTION_MIN_PROFITABLE_SLATES
    )


def build_hr_picks(
    annotated_rows: Iterable[dict[str, Any]],
    today: date,
    existing: dict[str, Any] | None = None,
    now_et: datetime | None = None,
) -> dict[str, Any]:
    rows = list(annotated_rows)
    existing = existing or {}
    cached_calibration = existing.get("calibration") if isinstance(existing.get("calibration"), dict) else None
    cached_rule = existing.get("rule") if isinstance(existing.get("rule"), dict) else None
    if cached_calibration and cached_calibration.get("ready") and cached_rule and cached_rule.get("frozen_for_forward_tracking"):
        discovery = cached_calibration
    else:
        discovery = discover_rule(rows)
    winner = discovery.get("winner")
    now = datetime.now(timezone.utc).isoformat()

    if winner is None:
        return {
            "schema_version": 1,
            "kind": "hr_form_picks_research",
            "status": "no_stable_rule",
            "generated_at": now,
            "promoted": False,
            "rule": None,
            "calibration": discovery,
            "retrospective": None,
            "forward": {
                "start": FORWARD_START.isoformat(),
                "promoted_at": None,
                "summary": strategy_summary([]),
                "daily": [],
                "snapshots": [],
            },
            "current": {
                "slate_date": today.isoformat(),
                "checkpoint": None,
                "status": "no_stable_rule",
                "picks": [],
            },
        }

    discovered_rule = dict(winner["rule"])
    existing_rule = existing.get("rule") if isinstance(existing.get("rule"), dict) else None
    if existing_rule and existing_rule.get("frozen_for_forward_tracking"):
        rule = dict(existing_rule)
    else:
        rule = discovered_rule
    complete = _complete_slate_rows(rows)
    retro_through = min(RETROSPECTIVE_END, today)
    retrospective_rows = _between(complete, RETROSPECTIVE_START, retro_through)
    retrospective_selected = select_rule(retrospective_rows, rule)
    retrospective = {
        "start": RETROSPECTIVE_START.isoformat(),
        "through": retro_through.isoformat(),
        "summary": strategy_summary(retrospective_selected),
        "promotion_evidence": False,
        "note": (
            "Retrospective diagnostic only. This period was visible while the HR research "
            "screen was being developed, so it is not used for promotion."
        ),
    }

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

    forward_rows = [
        {
            **pick,
            "best_odds": pick.get("odds"),
        }
        for snapshot in snapshots
        for pick in (snapshot.get("selections") or [])
    ]
    forward_summary = strategy_summary(forward_rows)
    promoted_at = existing_forward.get("promoted_at")
    if promoted_at is None and _promotion_pass(forward_summary):
        promoted_at = today.isoformat()

    current_date = today.isoformat()
    current_snapshot = next(
        (snapshot for snapshot in snapshots if snapshot.get("slate_date") == current_date),
        None,
    )
    has_checkpoint = any(
        str(row.get("slate_date") or "") == current_date
        and str(row.get("checkpoint") or "") == str(rule["checkpoint"])
        for row in rows
    )

    if today >= FORWARD_START and current_snapshot is None and has_checkpoint:
        current_rows = [
            row
            for row in rows
            if str(row.get("slate_date") or "") == current_date
            and str(row.get("checkpoint") or "") == str(rule["checkpoint"])
        ]
        selected = select_rule(current_rows, rule)
        mode = "primary"
        current_snapshot = {
            "slate_date": current_date,
            "checkpoint": rule["checkpoint"],
            "mode": mode,
            "captured_at": (
                next(
                    (
                        row.get("captured_at") or row.get("captured_at_et")
                        for row in current_rows
                        if row.get("captured_at") or row.get("captured_at_et")
                    ),
                    now,
                )
            ),
            "rule_id": rule["rule_id"],
            "selections": [_stored_pick(row, mode) for row in selected],
        }
        snapshots.append(current_snapshot)

    # Re-grade after a possible current snapshot was added.
    for snapshot in snapshots:
        snapshot["selections"] = [
            _grade_pick(dict(pick), lookup)
            for pick in (snapshot.get("selections") or [])
        ]

    forward_rows = [
        {
            **pick,
            "best_odds": pick.get("odds"),
        }
        for snapshot in snapshots
        for pick in (snapshot.get("selections") or [])
    ]
    forward_summary = strategy_summary(forward_rows)
    if promoted_at is None and _promotion_pass(forward_summary):
        promoted_at = today.isoformat()

    daily = _forward_daily(snapshots)
    current_snapshot = next(
        (snapshot for snapshot in snapshots if snapshot.get("slate_date") == current_date),
        None,
    )

    if current_snapshot is None:
        if today < FORWARD_START:
            current_status = "forward_not_started"
        elif now_et is None:
            current_status = "checkpoint_pending"
        else:
            hour, minute = int(str(rule["checkpoint"])[:2]), int(str(rule["checkpoint"])[2:])
            due_at = datetime.combine(today, time(hour, minute), HR_ET) + timedelta(minutes=20)
            current_status = "checkpoint_missed" if now_et >= due_at else "checkpoint_pending"
        current_picks: list[dict[str, Any]] = []
    else:
        current_status = "active"
        current_picks = list(current_snapshot.get("selections") or [])

    return {
        "schema_version": 1,
        "kind": "hr_form_picks_research",
        "status": "active",
        "generated_at": now,
        "promoted": promoted_at is not None,
        "methodology": {
            "discovery": (
                "Candidate execution rules span checkpoint, form band, odds band, best-price "
                "book, and a per-slate top-N cap. Candidate ranking never uses the retrospective "
                "or forward periods."
            ),
            "calibration": (
                f"Calibration is fixed at {CALIBRATION_START.isoformat()} through "
                f"{CALIBRATION_END.isoformat()} and split at the median recovered date. A rule "
                "must be profitable with positive empirical edge in both halves and the full "
                "block, clear minimum sample/slate counts, beat average market break-even with "
                "its full-block 90% Wilson lower hit-rate bound, and avoid one-day profit concentration."
            ),
            "retrospective": (
                f"{RETROSPECTIVE_START.isoformat()} through {RETROSPECTIVE_END.isoformat()} is "
                "reported only as a retrospective diagnostic because it was visible during strategy development."
            ),
            "forward": (
                f"Clean prospective tracking begins {FORWARD_START.isoformat()}. Primary picks "
                "are snapshotted once at the frozen checkpoint and never replaced. Validation "
                f"requires at least {PROMOTION_MIN_BETS} settled forward bets, "
                f"{PROMOTION_MIN_SLATES} betting slates, positive forward ROI, and at least "
                f"{PROMOTION_MIN_PROFITABLE_SLATES} profitable slates."
            ),
            "execution": (
                "One flat unit per settled HR prop. The frozen rule uses the best archived price "
                "at its checkpoint, ranks qualifiers by HR Form score then price, and takes at most "
                f"{rule['top_n']} players. Captures at or after game start are excluded. No plate "
                "appearance is a void."
            ),
        },
        "rule": {
            **rule,
            "frozen_for_forward_tracking": True,
        },
        "calibration": discovery,
        "retrospective": retrospective,
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
            "summary": forward_summary,
            "daily": daily,
            "snapshots": sorted(snapshots, key=lambda row: str(row.get("slate_date") or "")),
        },
        "current": {
            "slate_date": current_date,
            "checkpoint": rule["checkpoint"],
            "status": current_status,
            "picks": current_picks,
        },
    }
