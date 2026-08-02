from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from .model import normalize_name

CENTRAL_SHARED_BASE = (
    "https://raw.githubusercontent.com/aboderinf/"
    "mlb-hr-fair-odds-v1/main/generated/shared"
)
CENTRAL_LATEST_URL = f"{CENTRAL_SHARED_BASE}/latest.json"
BOOK_NAMES = {
    "fanduel": "FanDuel",
    "draftkings": "DraftKings",
    "betmgm": "BetMGM",
}
ET = ZoneInfo("America/New_York")


def _timestamp(value: Any) -> datetime:
    if not value:
        raise ValueError("Durable quote timestamp is missing")
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Durable quote timestamp must be timezone-aware")
    return parsed


def checkpoint_archive_url(slate_date: date, checkpoint: datetime) -> str:
    label = checkpoint.astimezone(ET).strftime("%H%M")
    return (
        f"{CENTRAL_SHARED_BASE}/archive/"
        f"{slate_date.isoformat()}_{label}.json"
    )


def _price(
    book_id: str,
    american_odds: Any,
    captured_at: Any,
    *,
    source: str,
    source_event_id: Any = None,
    source_odd_id: Any = None,
) -> dict[str, Any] | None:
    if book_id not in BOOK_NAMES or isinstance(american_odds, bool):
        return None
    try:
        offered = int(american_odds)
    except (TypeError, ValueError):
        return None
    if offered == 0 or not captured_at:
        return None
    try:
        _timestamp(captured_at)
    except ValueError:
        return None
    return {
        "book": BOOK_NAMES[book_id],
        "book_id": book_id,
        "odds": offered,
        "captured_at": str(captured_at),
        "source": source,
        "source_event_id": source_event_id,
        "source_odd_id": source_odd_id,
        "verified": True,
        "url": None,
    }


def _prediction_players(
    payload: dict[str, Any],
    capture_cutoff: datetime | None,
) -> list[dict[str, Any]]:
    players: list[dict[str, Any]] = []
    for row in payload.get("predictions") or []:
        name = str(row.get("batterName") or "").strip()
        batter_id = row.get("batterId")
        if not name or not batter_id:
            continue
        game_start_raw = row.get("gameStartAt")
        try:
            game_start = _timestamp(game_start_raw) if game_start_raw else None
        except ValueError:
            game_start = None

        prices: list[dict[str, Any]] = []
        for book_id, quote in (row.get("odds") or {}).items():
            if not isinstance(quote, dict):
                continue
            parsed = _price(
                str(book_id).lower(),
                quote.get("americanOdds"),
                quote.get("capturedAt"),
                source="mlb-hr-edge-durable-payload",
                source_event_id=quote.get("sourceEventId"),
                source_odd_id=quote.get("sourceOddId"),
            )
            if not parsed:
                continue
            captured = _timestamp(parsed["captured_at"])
            if capture_cutoff and captured > capture_cutoff:
                continue
            if game_start and captured >= game_start:
                continue
            prices.append(parsed)

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
                    "prediction_id": f"{payload.get('date')}:{int(batter_id)}",
                    "prices": prices,
                }
            )
    return players


def _market_players(
    payload: dict[str, Any],
    capture_cutoff: datetime | None,
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for quote in payload.get("marketQuotes") or []:
        name = str(quote.get("playerName") or "").strip()
        key = str(quote.get("playerKey") or normalize_name(name))
        event_id = str(quote.get("sourceEventId") or "")
        if not name or not key:
            continue
        parsed = _price(
            str(quote.get("bookmaker") or "").lower(),
            quote.get("americanOdds"),
            quote.get("capturedAt"),
            source="mlb-hr-edge-durable-market",
            source_event_id=quote.get("sourceEventId"),
            source_odd_id=quote.get("sourceOddId"),
        )
        if not parsed:
            continue
        captured = _timestamp(parsed["captured_at"])
        game_start_raw = quote.get("gameStartAt")
        try:
            game_start = _timestamp(game_start_raw) if game_start_raw else None
        except ValueError:
            game_start = None
        if capture_cutoff and captured > capture_cutoff:
            continue
        if game_start and captured >= game_start:
            continue

        group_key = (key, event_id)
        row = grouped.setdefault(
            group_key,
            {
                "name": name,
                "key": key,
                "batter_id": None,
                "batter_team": None,
                "matchup": (
                    f"{quote.get('awayTeam')} @ {quote.get('homeTeam')}"
                    if quote.get("awayTeam") and quote.get("homeTeam")
                    else None
                ),
                "lineup_position": None,
                "game_pk": None,
                "game_start_at": game_start_raw,
                "prediction_id": None,
                "prices": [],
            },
        )
        row["prices"].append(parsed)
    return list(grouped.values())


def parse_durable_payload(
    payload: dict[str, Any],
    expected_date: date | None = None,
    *,
    capture_cutoff: datetime | None = None,
    include_market_quotes: bool = True,
    source_url: str = CENTRAL_LATEST_URL,
) -> dict[str, Any]:
    source_date = str(payload.get("date") or "")
    if not source_date:
        raise ValueError("Durable MLB HR Edge payload has no slate date")
    if expected_date and source_date != expected_date.isoformat():
        raise ValueError(
            f"Durable payload returned {source_date!r}; "
            f"expected {expected_date.isoformat()}"
        )

    generated_at = payload.get("generatedAt")
    generated = _timestamp(generated_at)
    if capture_cutoff and generated > capture_cutoff:
        raise ValueError(
            "Durable payload was generated after the scheduled capture window"
        )

    prediction_players = _prediction_players(payload, capture_cutoff)
    players = list(prediction_players)
    if include_market_quotes:
        prediction_keys: set[tuple[str, str]] = set()
        for row in prediction_players:
            event_id = next(
                (
                    str(price.get("source_event_id"))
                    for price in row["prices"]
                    if price.get("source_event_id")
                ),
                "",
            )
            prediction_keys.add((row["key"], event_id))

        for row in _market_players(payload, capture_cutoff):
            event_id = next(
                (
                    str(price.get("source_event_id"))
                    for price in row["prices"]
                    if price.get("source_event_id")
                ),
                "",
            )
            if (row["key"], event_id) not in prediction_keys:
                players.append(row)

    books = sorted(
        {
            price["book"]
            for player in players
            for price in player.get("prices") or []
        }
    )
    return {
        "source": "MLB HR Edge durable shared payload",
        "source_url": source_url,
        "source_date": source_date,
        "date_matches": expected_date is None
        or source_date == expected_date.isoformat(),
        "as_of": capture_cutoff.isoformat() if capture_cutoff else None,
        "status": payload.get("status") or ("live" if players else "pending"),
        "generated_at": generated_at,
        "latest_ingest_at": generated_at,
        "books": books,
        "row_count": len(players),
        "players": players,
        "message": payload.get("message"),
        "prediction_rows": len(prediction_players),
        "market_quote_rows": len(payload.get("marketQuotes") or []),
    }
