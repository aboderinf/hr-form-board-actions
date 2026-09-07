from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model import portfolio_summary


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def rebuild(data_dir: Path, root: Path) -> None:
    snapshots = [
        load_json(path, {})
        for path in sorted((data_dir / "snapshots").glob("*.json"))
    ]
    aggregate: dict[str, Any] = {}
    for key in ("top10", "top20"):
        picks: list[dict[str, Any]] = []
        for snapshot in snapshots:
            portfolio = ((snapshot.get("portfolios") or {}).get(key) or {})
            picks.extend(portfolio.get("picks", []))
        aggregate[key] = portfolio_summary(picks)

    latest = load_json(data_dir / "latest.json", None)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "method": "0.50*L5 + 0.30*L7 + 0.20*L15 cumulative HR-game rates",
        "checkpoints_et": ["08:17", "11:17", "17:17", "20:17"],
        "aggregate": aggregate,
        "latest": latest,
        "snapshots": snapshots,
    }
    write_json(data_dir / "index.json", payload)
