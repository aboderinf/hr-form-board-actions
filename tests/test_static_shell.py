from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from src.storage import SHELL, render_site


class StaticShellTests(unittest.TestCase):
    def test_scores_enhancement_script_is_preserved(self) -> None:
        self.assertIn('/app.js', SHELL)
        self.assertIn('/scores-enhancements.js', SHELL)

    def test_rendered_shell_keeps_all_frontend_modules(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'index.html'
            render_site({}, output)
            html = output.read_text(encoding='utf-8')
            self.assertIn('/app.js', html)
            self.assertIn('/scores-enhancements.js', html)


if __name__ == '__main__':
    unittest.main()
