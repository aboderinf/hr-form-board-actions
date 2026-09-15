from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import mean
from typing import Any, Iterable

from .discovery import decimal_odds, implied_probability


CHECKPOINT_ORDER = ("0817", "1117", "1717")
POLICY_KEYS = ("hit_probability", "positive_ev")
VALUE_EDGE_RATIO = 1.25
VALUE_MIN_EXPECTED_ROI = 0.10
PICKS_PER_POLICY = 5


def parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def usable_model_board(payload: Any, slate_date: str | None = None) -> bool:
    if not isinstance(payload, dict) or payload.get("status") != "ready":
        return False
    if slate_date and payload.get("slate_date") != slate_date:
        return False
    if int(payload.get("sports_game_odds_objects_added") or 0) != 0:
        return False
    return bool(payload.get("players")) and parse_timestamp(payload.get("generated_at")) is not None


def _best_quote_rows(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[tuple[int, int], dict[str, Any]] = {}
    for row in entries:
        if row.get("mlbam_id") is None or row.get("game_pk") is None or row.get("best_odds") is None:
            continue
        key = (int(row["mlbam_id"]), int(row["game_pk"]))
        current = selected.get(key)
        if current is None or decimal_odds(int(row["best_odds"])) > decimal_odds(int(current["best_odds"])):
            selected[key] = row
    return list(selected.values())


def _public_pick(prediction: dict[str, Any], quote: dict[str, Any]) -> dict[str, Any]:
    probability = float(prediction["predicted_hit_probability"])
    odds = int(quote["best_odds"])
    market_probability = implied_probability(odds)
    return {
        "slate_date": quote.get("slate_date"),
        "checkpoint": quote.get("checkpoint"),
        "captured_at": quote.get("captured_at"),
        "game_pk": int(quote["game_pk"]),
        "game_start_at": quote.get("game_start_at"),
        "matchup": quote.get("matchup") or prediction.get("matchup"),
        "player": prediction.get("player") or quote.get("player"),
        "mlbam_id": int(prediction["mlbam_id"]),
        "team": prediction.get("team") or quote.get("team"),
        "probability_rank": prediction.get("probability_rank"),
        "predicted_hit_probability": probability,
        "model_rank_score": prediction.get("model_rank_score"),
        "fair_american_odds": prediction.get("fair_american_odds"),
        "best_book": quote.get("best_book"),
        "best_odds": odds,
        "market_implied_probability": market_probability,
        "edge_ratio": probability / market_probability if market_probability else None,
        "expected_roi": probability * decimal_odds(odds) - 1.0,
        "result": quote.get("result"),
        "triples": quote.get("triples"),
        "plate_appearances": quote.get("plate_appearances"),
        "profit_units": quote.get("profit_units"),
    }


def select_checkpoint_policies(
    board: dict[str, Any],
    entries: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Select executable model policies from one fixed checkpoint.

    The model board must have existed at capture time, and a quoted player-game
    must not have started. Price never affects the hit-probability ranking.
    """

    rows = _best_quote_rows(entries)
    captured_times = [parse_timestamp(row.get("captured_at")) for row in rows]
    captured_times = [value for value in captured_times if value is not None]
    capture_at = min(captured_times) if captured_times else None
    generated_at = parse_timestamp(board.get("generated_at"))
    base = {
        "capture_at": capture_at.isoformat() if capture_at else None,
        "model_generated_at": board.get("generated_at"),
        "priced_player_games": len(rows),
        "matched_model_player_games": 0,
        "post_start_rows_excluded": 0,
        "hit_probability": [],
        "positive_ev": [],
    }
    if capture_at is None:
        return {**base, "status": "no_capture_time"}
    if generated_at is None or generated_at > capture_at:
        return {**base, "status": "model_not_available_at_checkpoint"}

    quotes = {(int(row["mlbam_id"]), int(row["game_pk"])): row for row in rows}
    candidates: list[dict[str, Any]] = []
    post_start = 0
    for prediction in board.get("players") or []:
        if prediction.get("mlbam_id") is None or prediction.get("game_pk") is None:
            continue
        key = (int(prediction["mlbam_id"]), int(prediction["game_pk"]))
        quote = quotes.get(key)
        if quote is None:
            continue
        game_start = parse_timestamp(quote.get("game_start_at") or prediction.get("game_start_at"))
        if game_start is None or capture_at >= game_start:
            post_start += 1
            continue
        if prediction.get("predicted_hit_probability") is None:
            continue
        candidates.append(_public_pick(prediction, quote))

    ranked = sorted(
        candidates,
        key=lambda row: (
            -float(row.get("predicted_hit_probability") or 0.0),
            -float(row.get("model_rank_score") or 0.0),
            str(row.get("player") or ""),
        ),
    )
    value = [
        row
        for row in candidates
        if float(row.get("edge_ratio") or 0.0) >= VALUE_EDGE_RATIO
        and float(row.get("expected_roi") or -1.0) >= VALUE_MIN_EXPECTED_ROI
    ]
    value.sort(
        key=lambda row: (
            -float(row.get("expected_roi") or -1.0),
            -float(row.get("predicted_hit_probability") or 0.0),
            str(row.get("player") or ""),
        )
    )
    return {
        **base,
        "status": "ready" if candidates else "no_model_price_matches",
        "matched_model_player_games": len(candidates),
        "post_start_rows_excluded": post_start,
        "hit_probability": ranked[:PICKS_PER_POLICY],
        "positive_ev": value[:PICKS_PER_POLICY],
    }


def build_daily_archive(
    board: dict[str, Any],
    entries: Iterable[dict[str, Any]],
    *,
    source: str,
) -> dict[str, Any]:
    slate_date = str(board["slate_date"])
    by_checkpoint: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in entries:
        if str(row.get("slate_date")) == slate_date:
            by_checkpoint[str(row.get("checkpoint"))].append(row)
    return {
        "schema_version": 1,
        "kind": "triples_model_pick_slate",
        "slate_date": slate_date,
        "model_generated_at": board.get("generated_at"),
        "model_source": source,
        "checkpoints": {
            checkpoint: select_checkpoint_policies(board, by_checkpoint.get(checkpoint, []))
            for checkpoint in CHECKPOINT_ORDER
        },
    }


def policy_summary(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    values = list(rows)
    settled = [row for row in values if row.get("result") in {"WIN", "LOSS"}]
    wins = sum(row.get("result") == "WIN" for row in settled)
    losses = len(settled) - wins
    voids = sum(row.get("result") == "VOID" for row in values)
    net_units = sum(float(row.get("profit_units") or 0.0) for row in settled)
    model_probabilities = [float(row["predicted_hit_probability"]) for row in settled]
    market_probabilities = [float(row["market_implied_probability"]) for row in settled]
    slates = len({str(row.get("slate_date")) for row in values})
    if len(settled) >= 100 and wins >= 5 and slates >= 14:
        sample_status = "developing"
    elif len(settled) >= 40 and wins >= 3 and slates >= 7:
        sample_status = "provisional"
    else:
        sample_status = "small sample"
    return {
        "picks": len(values),
        "bets": len(settled),
        "slates": slates,
        "wins": wins,
        "losses": losses,
        "voids": voids,
        "hit_rate": wins / len(settled) if settled else None,
        "average_model_probability": mean(model_probabilities) if model_probabilities else None,
        "average_market_break_even": mean(market_probabilities) if market_probabilities else None,
        "net_units": net_units,
        "roi": net_units / len(settled) if settled else None,
        "average_odds": mean(int(row["best_odds"]) for row in settled) if settled else None,
        "average_expected_roi_at_pick": mean(float(row["expected_roi"]) for row in settled) if settled else None,
        "sample_status": sample_status,
    }


def period_report(
    archives: Iterable[dict[str, Any]],
    start: date,
    end: date,
) -> dict[str, Any]:
    slates = [
        archive
        for archive in archives
        if start <= date.fromisoformat(str(archive["slate_date"])) <= end
    ]
    checkpoint_reports = []
    for checkpoint in CHECKPOINT_ORDER:
        checkpoint_slates = [
            (archive.get("checkpoints") or {}).get(checkpoint) or {}
            for archive in slates
        ]
        report: dict[str, Any] = {
            "label": checkpoint,
            "executable_slates": sum(row.get("status") == "ready" for row in checkpoint_slates),
            "matched_model_player_games": sum(int(row.get("matched_model_player_games") or 0) for row in checkpoint_slates),
        }
        for policy in POLICY_KEYS:
            report[policy] = policy_summary(
                pick
                for checkpoint_row in checkpoint_slates
                for pick in checkpoint_row.get(policy) or []
            )
        checkpoint_reports.append(report)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "model_slates": len(slates),
        "latest_model_slate": max((str(row["slate_date"]) for row in slates), default=None),
        "checkpoints": checkpoint_reports,
    }


def build_reports(archives: Iterable[dict[str, Any]], today: date) -> dict[str, Any]:
    values = list(archives)
    first = min((date.fromisoformat(str(row["slate_date"])) for row in values), default=today)
    return {
        "rolling_14d": period_report(values, today - timedelta(days=13), today),
        "calendar_month": period_report(values, today.replace(day=1), today),
        "all_time": period_report(values, first, today),
    }


def build_output(
    archives: Iterable[dict[str, Any]],
    today: date,
    *,
    candidate_dates: Iterable[str],
    incomplete_dates: Iterable[str],
    missing_model_dates: Iterable[str],
    diagnostics: Iterable[str],
) -> dict[str, Any]:
    values = sorted(archives, key=lambda row: str(row.get("slate_date") or ""))
    recent: list[dict[str, Any]] = []
    for archive in reversed(values):
        for checkpoint in CHECKPOINT_ORDER:
            checkpoint_row = (archive.get("checkpoints") or {}).get(checkpoint) or {}
            for policy in POLICY_KEYS:
                recent.extend({**pick, "policy": policy} for pick in checkpoint_row.get(policy) or [])
    recent.sort(
        key=lambda row: (str(row.get("slate_date") or ""), str(row.get("checkpoint") or ""), str(row.get("player") or "")),
        reverse=True,
    )
    ready_dates = {
        str(archive["slate_date"])
        for archive in values
        if any(
            ((archive.get("checkpoints") or {}).get(checkpoint) or {}).get("status") == "ready"
            for checkpoint in CHECKPOINT_ORDER
        )
    }
    now = datetime.now(timezone.utc)
    return {
        "schema_version": 1,
        "kind": "triples_model_pick_discovery",
        "status": "ready" if values else "no_model_slates",
        "generated_at": now.isoformat(),
        "as_of_slate": today.isoformat(),
        "settled_through": values[-1]["slate_date"] if values else None,
        "policy": {
            "hit_probability": f"Up to {PICKS_PER_POLICY} priced player-games ranked by calibrated hit probability; price does not affect rank.",
            "positive_ev": f"Up to {PICKS_PER_POLICY} priced player-games ranked by expected ROI after edge ratio ≥ {VALUE_EDGE_RATIO:.2f} and expected ROI ≥ {VALUE_MIN_EXPECTED_ROI:.0%}.",
            "pricing": "Each 08:17, 11:17, and 17:17 ET checkpoint is evaluated separately at its best available book quote.",
            "timing_guard": "A prediction must exist by the checkpoint, and picks whose games already started are excluded.",
            "stake": "One unit per settled pick; American-odds profit on wins and -1 unit on losses.",
            "warning": "Triples are rare and the live out-of-sample archive remains provisional. Model-estimated edge is not a guarantee of profit.",
        },
        "data_quality": {
            "candidate_completed_slates": len(set(candidate_dates)),
            "archived_model_slates": len(values),
            "executable_model_slates": len(ready_dates),
            "missing_model_dates": sorted(set(missing_model_dates)),
            "non_executable_model_dates": sorted(
                str(archive["slate_date"])
                for archive in values
                if str(archive["slate_date"]) not in ready_dates
            ),
            "excluded_incomplete_slates": sorted(set(incomplete_dates)),
            "provider_requests_added": 0,
            "provider_objects_added": 0,
        },
        "reports": build_reports(values, today),
        "recent_picks": recent[:120],
        "diagnostics": list(diagnostics)[:100],
    }
