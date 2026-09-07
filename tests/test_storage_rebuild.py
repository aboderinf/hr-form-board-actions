import json
import tempfile
import unittest
from pathlib import Path

from src.storage import rebuild


class StorageRebuildTests(unittest.TestCase):
    def test_rebuild_updates_data_without_rewriting_site_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data_dir = root / "data"
            (data_dir / "snapshots").mkdir(parents=True)
            (data_dir / "latest.json").write_text("null\n", encoding="utf-8")
            index_html = root / "index.html"
            sentinel = "<html>keep-ui-shell</html>"
            index_html.write_text(sentinel, encoding="utf-8")

            rebuild(data_dir, root)

            self.assertEqual(index_html.read_text(encoding="utf-8"), sentinel)
            payload = json.loads((data_dir / "index.json").read_text(encoding="utf-8"))
            self.assertIn("top10", payload["aggregate"])
            self.assertIn("top20", payload["aggregate"])


if __name__ == "__main__":
    unittest.main()
