from __future__ import annotations

import hashlib
import hmac
import json
import unittest
from unittest.mock import patch

from src.triples_model_runtime import RedisRest


class Response:
    status = 200
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return False
    def read(self):
        return b'{"result":"saved model state"}'


class ArchiveGatewayTests(unittest.TestCase):
    def test_active_model_reads_and_owner_releases_use_authenticated_gateway(self):
        observed = []
        def open_request(request, **_kwargs):
            observed.append(request)
            return Response()
        with patch.dict("os.environ", {"ARCHIVE_MODE": "active", "QSTASH_TOKEN": "test-only", "ARCHIVE_GATEWAY_URL": "https://archive.example.test/api/capture-checkpoint?action=archive-record"}), patch("src.triples_model_runtime.urlopen", side_effect=open_request):
            store = RedisRest("https://redis.example.test", "redis-secret")
            self.assertEqual(store.command(["GET", "mlbhr:triples-model:2026-09-14"]), "saved model state")
            store.release_lease("mlbhr:triples-model:lock:2026-09-14", "owner")
        self.assertEqual(len(observed), 2)
        for request in observed:
            self.assertEqual(request.host, "archive.example.test")
            self.assertEqual(request.get_header("X-checkpoint-auth"), hmac.new(b"test-only", b"hr-form-checkpoint-v1", hashlib.sha256).hexdigest())
            self.assertIsNone(request.get_header("Authorization"))
            self.assertNotIn(b"redis-secret", request.data)
        self.assertEqual(json.loads(observed[1].data)["command"], ["RELEASE", "mlbhr:triples-model:lock:2026-09-14", "owner"])

    def test_gateway_does_not_silently_fall_back_to_redis_when_auth_is_missing(self):
        with patch.dict("os.environ", {"ARCHIVE_MODE": "active", "QSTASH_TOKEN": ""}), patch("src.triples_model_runtime.urlopen") as request:
            with self.assertRaisesRegex(RuntimeError, "QSTASH_TOKEN"):
                RedisRest("https://redis.example.test", "secret").command(["GET", "mlbhr:triples-model:latest"])
            request.assert_not_called()

    def test_archive_off_preserves_existing_redis_protocol(self):
        with patch.dict("os.environ", {"ARCHIVE_MODE": "off"}), patch("src.triples_model_runtime.urlopen", return_value=Response()) as request:
            RedisRest("https://redis.example.test", "secret").command(["GET", "mlbhr:triples-model:latest"])
            self.assertEqual(json.loads(request.call_args.args[0].data), ["GET", "mlbhr:triples-model:latest"])
            self.assertEqual(request.call_args.args[0].host, "redis.example.test")


if __name__ == "__main__":
    unittest.main()
