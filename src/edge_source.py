from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from .durable_source import (
    CENTRAL_LATEST_URL,
    checkpoint_archive_url,
    parse_durable_payload,
)
from .model import normalize_name

EDGE_BASE_URL = "https://mlb-hr-edge.feranmi.chatgpt.site"
EDGE_ODDS_URL = f"{EDGE_BASE_URL}/api/odds"
EDGE_DASHBOARD_URL = f"{EDGE_BASE_URL}/api/dashboard"
BOOK_NAMES = {
    "fanduel": "FanDuel",
    "draftkings": "DraftKings",
    "betmgm": "BetMGM",
}
MAX_SHARED_SNAPSHOT_AGE = timedelta(minutes=60)
CHECKPOINT_CAPTURE_GRACE = timedelta(minutes=15)


def _parse_timestamp(value: Any) -> datetime:
    if not value:
        raise ValueError("Shared odds timestamp is missing")
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Shared odds timestamp must be timezone-aware")
    return parsed


def parse_edge_payload(
    payload: dict[str, Any],
    expected_date: date | None = None,
    *,
    enforce_checkpoint_age: bool = True,
    require_confirmed_lineup: bool = True,
) -> dict[str, Any]:
    if payload.get("source") != "mlb-hr-edge-database":
        raise ValueError("MLB HR Edge response was not database-backed")
    if payload.get("status") == "error":
        raise ValueError(payload.get("message") or "MLB HR Edge odds API error")

    source_date = str(payload.get("date") or "")
    if not source_date:
        raise ValueError("MLB HR Edge response did not include a slate date")
    if expected_date and source_date != expected_date.isoformat():
        raise ValueError(
            f"MLB HR Edge returned {source_date!r}; expected {expected_date.isoformat()}"
        )

    players: list[dict[str, Any]] = []
    for row in payload.get("rows") or []:
        if row.get("gameDate") != source_date:
            continue
        if require_confirmed_lineup and not row.get("lineupConfirmed"):
            continue

        batter_id = row.get("batterId")
        name = str(row.get("batterName") or "").strip()
        if not name or (require_confirmed_lineup and not batter_id):
            continue

        prices: list[dict[str, Any]] = []
        for book_id, quote in (row.get("odds") or {}).items():
            if book_id not in BOOK_NAMES or not isinstance(quote, dict):
                continue
            raw_odds = quote.get("americanOdds")
            if isinstance(raw_odds, bool):
                continue
            try:
                offered = int(raw_odds)
            except (TypeError, ValueError):
                continue
            captured_at = quote.get("capturedAt")
            if offered == 0 or not captured_at:
                continue
            prices.append(
                {
                    "book": BOOK_NAMES[book_id],
                    "book_id": book_id,
                    "odds": offered,
                    "captured_at": str(captured_at),
                    "source": str(quote.get("source") or "mlb-hr-edge"),
                    "source_event_id": quote.get("sourceEventId") or row.get("sourceEventId"),
                    "source_odd_id": quote.get("sourceOddId"),
                    "provider_call_id": quote.get("callId") or payload.get("providerCallId"),
                    "verified": True,
                    "url": None,
                }
            )

        if prices:
            players.append(
                {
                    "name": name,
                    "key": str(row.get("playerKey") or normalize_name(name)),
                    "batter_id": int(batter_id) if batter_id else None,
                    "batter_team": row.get("batterTeam"),
                    "matchup": row.get("matchup"),
                    "lineup_position": row.get("lineupPosition"),
                    "lineup_confirmed": bool(row.get("lineupConfirmed")),
                    "game_pk": row.get("gamePk"),
                    "game_start_at": row.get("gameStartAt"),
                    "prediction_id": row.get("predictionId"),
                    "source_event_id": row.get("sourceEventId"),
                    "prices": prices,
                }
            )

    if players and enforce_checkpoint_age:
        cutoff = _parse_timestamp(payload.get("asOf"))
        generated = _parse_timestamp(payload.get("generatedAt"))
        age = cutoff - generated
        if age < timedelta(0):
            raise ValueError("Shared odds snapshot was captured after the allowed source window")
        if age > MAX_SHARED_SNAPSHOT_AGE:
            raise ValueError(f"Shared odds snapshot is stale for this checkpoint ({age})")

    return {
        "source": "MLB HR Edge",
        "source_url": EDGE_ODDS_URL,
        "source_date": source_date,
        "date_matches": expected_date is None or source_date == expected_date.isoformat(),
        "as_of": payload.get("asOf"),
        "status": payload.get("status") or "pending",
        "generated_at": payload.get("generatedAt"),
        "latest_ingest_at": payload.get("latestIngestAt"),
        "provider_call_id": payload.get("providerCallId"),
        "provider_response_sha256": payload.get("providerResponseSha256"),
        "archived_call_count": int(payload.get("archivedCallCount") or 0),
        "quote_count": int(payload.get("quoteCount") or 0),
        "books": [BOOK_NAMES.get(x, x) for x in (payload.get("books") or [])],
        "row_count": int(payload.get("rowCount") or len(players)),
        "players": players,
    }


def _dashboard_payload(
    payload: dict[str, Any],
    slate_date: date,
    as_of: datetime | None = None,
) -> dict[str, Any] | None:
    if payload.get("source") != "database":
        return None
    rows: list[dict[str, Any]] = []
    latest_capture: datetime | None = None
    for row in payload.get("rows") or []:
        offered: dict[str, dict[str, Any]] = {}
        game_start_raw = row.get("gameStartAt")
        game_start = _parse_timestamp(game_start_raw) if game_start_raw else None
        for book_id, quote in (row.get("odds") or {}).items():
            if book_id not in BOOK_NAMES or not isinstance(quote, dict):
                continue
            if quote.get("americanOdds") is None or not quote.get("capturedAt"):
                continue
            try:
                captured = _parse_timestamp(quote.get("capturedAt"))
            except ValueError:
                continue
            if as_of and captured > as_of:
                continue
            if game_start and captured >= game_start:
                continue
            offered[book_id] = {
                "americanOdds": quote["americanOdds"],
                "capturedAt": quote["capturedAt"],
                "source": "mlb-hr-edge-dashboard",
                "sourceEventId": quote.get("sourceEventId"),
                "sourceOddId": quote.get("sourceOddId"),
            }
            if latest_capture is None or captured > latest_capture:
                latest_capture = captured
        if offered:
            rows.append(
                {
                    "predictionId": row.get("id"),
                    "gameDate": row.get("gameDate") or slate_date.isoformat(),
                    "gamePk": row.get("gamePk"),
                    "gameStartAt": row.get("gameStartAt"),
                    "batterId": row.get("batterId"),
                    "batterName": row.get("batterName"),
                    "batterTeam": row.get("batterTeam"),
                    "matchup": row.get("matchup"),
                    "lineupPosition": row.get("lineupPosition"),
                    "lineupConfirmed": True,
                    "odds": offered,
                }
            )
    if not rows:
        return None
    return {
        "schemaVersion": 1,
        "date": slate_date.isoformat(),
        "asOf": as_of.isoformat() if as_of else None,
        "generatedAt": latest_capture.isoformat() if latest_capture else payload.get("generatedAt"),
        "latestIngestAt": payload.get("generatedAt"),
        "status": payload.get("feedStatus") or "live",
        "source": "mlb-hr-edge-database",
        "books": list(BOOK_NAMES),
        "rowCount": len(rows),
        "rows": rows,
    }


def fetch_edge_odds(client: Any, expected_date: date, as_of: datetime) -> dict[str, Any]:
    capture_cutoff = as_of + CHECKPOINT_CAPTURE_GRACE
    query = urlencode({"date": expected_date.isoformat(), "asOf": capture_cutoff.isoformat()})
    errors: list[str] = []
    try:
        market = parse_edge_payload(client.json(f"{EDGE_ODDS_URL}?{query}"), expected_date)
        market["checkpoint_at"] = as_of.isoformat()
        market["capture_cutoff"] = capture_cutoff.isoformat()
        return market
    except Exception as exc:
        errors.append(f"odds API: {exc}")

    dashboard_query = urlencode({"date": expected_date.isoformat()})
    try:
        converted = _dashboard_payload(
            client.json(f"{EDGE_DASHBOARD_URL}?{dashboard_query}"),
            expected_date,
            capture_cutoff,
        )
        if converted:
            market = parse_edge_payload(converted, expected_date)
            market["source_url"] = f"{EDGE_DASHBOARD_URL}?{dashboard_query}"
            market["compatibility_fallback"] = "dashboard"
            market["checkpoint_at"] = as_of.isoformat()
            market["capture_cutoff"] = capture_cutoff.isoformat()
            return market
        errors.append("dashboard: no verified prices inside source window")
    except Exception as exc:
        errors.append(f"dashboard: {exc}")

    archive_url = checkpoint_archive_url(expected_date, as_of)
    try:
        market = parse_durable_payload(
            client.json(archive_url),
            expected_date,
            capture_cutoff=capture_cutoff,
            include_market_quotes=False,
            source_url=archive_url,
        )
        if not market["players"]:
            raise ValueError("payload contained no prediction-linked prices")
        market["compatibility_fallback"] = "durable_archive"
        market["checkpoint_at"] = as_of.isoformat()
        market["capture_cutoff"] = capture_cutoff.isoformat()
        return market
    except Exception as exc:
        errors.append(f"durable archive: {exc}")
    raise ValueError("Shared MLB HR odds unavailable; " + " | ".join(errors))


def fetch_latest_edge_odds(client: Any) -> dict[str, Any]:
    errors: list[str] = []
    try:
        payload = client.json(f"{EDGE_ODDS_URL}?latest=1")
        return parse_edge_payload(
            payload,
            None,
            enforce_checkpoint_age=False,
            require_confirmed_lineup=False,
        )
    except Exception as exc:
        errors.append(f"odds API: {exc}")

    today = datetime.now(ZoneInfo("America/New_York")).date()
    for offset in range(0, 8):
        slate_date = today - timedelta(days=offset)
        query = urlencode({"date": slate_date.isoformat()})
        try:
            converted = _dashboard_payload(client.json(f"{EDGE_DASHBOARD_URL}?{query}"), slate_date)
            if converted:
                market = parse_edge_payload(converted, None, enforce_checkpoint_age=False)
                market["source_url"] = f"{EDGE_DASHBOARD_URL}?{query}"
                market["compatibility_fallback"] = "dashboard"
                return market
        except Exception as exc:
            errors.append(f"dashboard {slate_date}: {exc}")

    try:
        market = parse_durable_payload(
            client.json(CENTRAL_LATEST_URL),
            None,
            include_market_quotes=True,
            source_url=CENTRAL_LATEST_URL,
        )
        market["compatibility_fallback"] = "durable_latest"
        return market
    except Exception as exc:
        errors.append(f"durable latest: {exc}")
    raise ValueError("No shared MLB HR odds snapshot was found; " + " | ".join(errors[-4:]))
