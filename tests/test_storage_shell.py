from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from src.storage import SHELL, render_site


class StorageShellTests(unittest.TestCase):
    def test_generated_shell_loads_discovery_and_scores_enhancements(self):
        self.assertIn('src="/discovery-enhancements.js"', SHELL)
        self.assertIn('src="/scores-enhancements.js"', SHELL)

    def test_render_site_preserves_discovery_loader(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "index.html"
            render_site({}, output)
            html = output.read_text(encoding="utf-8")
            self.assertIn('src="/discovery-enhancements.js"', html)
            self.assertIn('src="/scores-enhancements.js"', html)


if __name__ == "__main__":
    unittest.main()
