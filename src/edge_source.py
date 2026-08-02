from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

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
        if row.get("gameDate") != source_date or not row.get("lineupConfirmed"):
            continue
        batter_id = row.get("batterId")
        name = str(row.get("batterName") or "").strip()
        if not batter_id or not name:
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
            prices.append({
                "book": BOOK_NAMES[book_id],
                "book_id": book_id,
                "odds": offered,
                "captured_at": str(captured_at),
                "source": str(quote.get("source") or "mlb-hr-edge"),
                "source_event_id": quote.get("sourceEventId"),
                "source_odd_id": quote.get("sourceOddId"),
                "verified": True,
                "url": None,
            })

        if prices:
            players.append({
                "name": name,
                "key": normalize_name(name),
                "batter_id": int(batter_id),
                "batter_team": row.get("batterTeam"),
                "matchup": row.get("matchup"),
                "lineup_position": row.get("lineupPosition"),
                "game_pk": row.get("gamePk"),
                "game_start_at": row.get("gameStartAt"),
                "prediction_id": row.get("predictionId"),
                "prices": prices,
            })

    if players and enforce_checkpoint_age:
        cutoff = _parse_timestamp(payload.get("asOf"))
        generated = _parse_timestamp(payload.get("generatedAt"))
        age = cutoff - generated
        if age < timedelta(0):
            raise ValueError("Shared odds snapshot was captured after the checkpoint")
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
        "books": [BOOK_NAMES.get(x, x) for x in (payload.get("books") or [])],
        "row_count": int(payload.get("rowCount") or len(players)),
        "players": players,
    }


def _dashboard_payload(payload: dict[str, Any], slate_date: date) -> dict[str, Any] | None:
    if payload.get("source") != "database":
        return None
    rows = []
    for row in payload.get("rows") or []:
        offered = {}
        for book_id, quote in (row.get("odds") or {}).items():
            if book_id not in BOOK_NAMES or not isinstance(quote, dict):
                continue
            if quote.get("americanOdds") is None or not quote.get("capturedAt"):
                continue
            offered[book_id] = {
                "americanOdds": quote["americanOdds"],
                "capturedAt": quote["capturedAt"],
                "source": "mlb-hr-edge-dashboard",
                "sourceEventId": None,
                "sourceOddId": None,
            }
        if not offered:
            continue
        rows.append({
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
        })
    if not rows:
        return None
    return {
        "schemaVersion": 1,
        "date": slate_date.isoformat(),
        "asOf": None,
        "generatedAt": payload.get("generatedAt"),
        "latestIngestAt": payload.get("generatedAt"),
        "status": payload.get("feedStatus") or "live",
        "source": "mlb-hr-edge-database",
        "books": list(BOOK_NAMES),
        "rowCount": len(rows),
        "rows": rows,
    }


def fetch_edge_odds(client: Any, expected_date: date, as_of: datetime) -> dict[str, Any]:
    query = urlencode({"date": expected_date.isoformat(), "asOf": as_of.isoformat()})
    return parse_edge_payload(client.json(f"{EDGE_ODDS_URL}?{query}"), expected_date)


def fetch_latest_edge_odds(client: Any) -> dict[str, Any]:
    try:
        payload = client.json(f"{EDGE_ODDS_URL}?latest=1")
        return parse_edge_payload(payload, None, enforce_checkpoint_age=False)
    except Exception:
        today = datetime.now(ZoneInfo("America/New_York")).date()
        for offset in range(0, 8):
            slate_date = today - timedelta(days=offset)
            query = urlencode({"date": slate_date.isoformat()})
            dashboard = client.json(f"{EDGE_DASHBOARD_URL}?{query}")
            converted = _dashboard_payload(dashboard, slate_date)
            if converted:
                return parse_edge_payload(converted, None, enforce_checkpoint_age=False)
        raise ValueError("No database-backed MLB HR Edge slate with verified odds was found")
