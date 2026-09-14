"""Run resumable verified archive batches; credentials come only from environment."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import time
from urllib.request import Request, urlopen


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="https://hr-form-board-actions.vercel.app")
    parser.add_argument("--mode", choices=("mirror", "active"), required=True)
    parser.add_argument("--max-batches", type=int, default=150)
    args = parser.parse_args()
    if not args.origin.startswith("https://"):
        parser.error("origin must use HTTPS")
    token = os.environ.get("QSTASH_TOKEN", "")
    if not token:
        parser.error("Set QSTASH_TOKEN securely in the environment; do not pass it as an argument")
    auth = hmac.new(token.encode(), b"hr-form-checkpoint-v1", hashlib.sha256).hexdigest()
    for _ in range(args.max_batches):
        request = Request(args.origin.rstrip("/") + "/api/capture-checkpoint?action=archive-migrate",
                          headers={"Content-Type": "application/json", "x-checkpoint-auth": auth},
                          data=json.dumps({"maxRecords": 32}).encode(), method="POST")
        with urlopen(request, timeout=240) as response:
            result = json.load(response)["result"]
        if result.get("mode") not in (None, args.mode):
            raise SystemExit("Server archive mode does not match the requested migration phase")
        print(json.dumps(result), flush=True)
        if result.get("completedAt"):
            return
        if result.get("status") == "archive_not_enabled":
            raise SystemExit("Configure mirror mode before starting migration")
        time.sleep(30 if result.get("status") == "awaiting_writer_drain" else 2)
    raise SystemExit("Batch limit reached; rerun the same command to resume safely")


if __name__ == "__main__":
    main()
