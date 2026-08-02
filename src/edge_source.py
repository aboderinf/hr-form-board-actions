from __future__ import annotations

from datetime import date, datetime
from typing import Any
from urllib.parse import urlencode

from .model import normalize_name

EDGE_ODDS_URL = "https://mlb-hr-edge.feranmi.chatgpt.site/api/odds"
BOOK_NAMES = {
    "fanduel": "FanDuel",
    "draftkings": "DraftKings",
    "betmgm": "BetMGM",
}


def parse_edge_payload(payload: dict[str, Any], expected_date: date) -> dict[str, Any]:
    expected = expected_date.isoformat()
    if payload.get("source") != "mlb-hr-edge-database":
        raise ValueError("MLB HR Edge response was not database-backed")
    if payload.get("date") != expected:
        raise ValueError(
            f"MLB HR Edge returned {payload.get('date')!r}; expected {expected}"
        )
    if payload.get("status") == "error":
        raise ValueError(payload.get("message") or "MLB HR Edge odds API error")

    players: list[dict[str, Any]] = []
    for row in payload.get("rows") or []:
        if row.get("gameDate") != expected or not row.get("lineupConfirmed"):
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
                odds = int(raw_odds)
            except (TypeError, ValueError):
                continue
            captured_at = quote.get("capturedAt")
            if odds == 0 or not captured_at:
                continue
            prices.append(
                {
                    "book": BOOK_NAMES[book_id],
                    "book_id": book_id,
                    "odds": odds,
                    "captured_at": str(captured_at),
                    "source": str(quote.get("source") or "sportsgameodds"),
                    "source_event_id": quote.get("sourceEventId"),
                    "source_odd_id": quote.get("sourceOddId"),
                    "verified": True,
                    "url": None,
                }
            )

        if prices:
            players.append(
                {
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
                }
            )

    return {
        "source": "MLB HR Edge",
        "source_url": EDGE_ODDS_URL,
        "source_date": expected,
        "date_matches": True,
        "as_of": payload.get("asOf"),
        "status": payload.get("status") or "pending",
        "generated_at": payload.get("generatedAt"),
        "latest_ingest_at": payload.get("latestIngestAt"),
        "books": [BOOK_NAMES.get(x, x) for x in (payload.get("books") or [])],
        "row_count": int(payload.get("rowCount") or len(players)),
        "players": players,
    }


def fetch_edge_odds(
    client: Any,
    expected_date: date,
    as_of: datetime,
) -> dict[str, Any]:
    query = urlencode(
        {
            "date": expected_date.isoformat(),
            "asOf": as_of.isoformat(),
        }
    )
    payload = client.json(f"{EDGE_ODDS_URL}?{query}")
    return parse_edge_payload(payload, expected_date)
