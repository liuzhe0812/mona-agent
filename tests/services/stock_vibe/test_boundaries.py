from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools.stock_vibe.check_boundaries import check_python

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_CHECKER = REPO_ROOT / "tools" / "stock_vibe" / "check_boundaries.mjs"


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class PythonBoundaryTests(unittest.TestCase):
    def test_utf8_bom_does_not_hide_imports(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root, "mona/services/stock_vibe/__init__.py", "\ufefffrom mona.agent.loop import AgentLoop\n")
            self.assertTrue(any("forbidden Python dependency mona.agent.loop" in error for error in check_python(root)))

    def test_follows_imports_and_static_dynamic_imports(self) -> None:
        cases = (
            (
                "from mona.services.stock import api",
                "mona.services.stock",
            ),
            (
                "import importlib as loader\nloader.import_module('mona.agent.tools.stock_query')",
                "mona.agent.tools.stock_query",
            ),
            (
                "from importlib import import_module as load\nload('mona.agent.loop')",
                "mona.agent.loop",
            ),
            (
                "agent_loop.process_direct('prompt')",
                "AgentLoop.process_direct",
            ),
        )
        for source, expected in cases:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                write(root, "mona/services/stock_vibe/__init__.py", "from . import facade\n")
                write(root, "mona/services/stock_vibe/facade.py", "from . import aggregator\n")
                write(root, "mona/services/stock_vibe/aggregator.py", source + "\n")
                self.assertTrue(any(expected in error for error in check_python(root)))

    def test_generic_runtime_boundary_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root, "mona/services/stock_vibe/__init__.py", "from mona.runtime.official import install\n")
            write(root, "mona/runtime/official.py", "from mona.services.stock import legacy\n")
            self.assertEqual([], check_python(root))


class TypeScriptBoundaryTests(unittest.TestCase):
    def run_checker(self, root: Path) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        return subprocess.run(
            ["node", str(TS_CHECKER), "--root", str(root)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

    def make_ts_root(self, root: Path) -> None:
        write(
            root,
            "webui/tsconfig.json",
            '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]},"moduleResolution":"bundler"}}',
        )
        write(root, "webui/src/components/stock-vibe/entry.ts", "export { item } from './barrel';\n")
        write(root, "webui/src/components/ui/Badge.ts", "export const Badge = 'Badge';\n")

    def test_reexport_aggregate_chain_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_ts_root(root)
            write(root, "webui/src/components/stock-vibe/barrel.ts", "export * from '@/components/aggregates/old-stock';\n")
            write(root, "webui/src/components/aggregates/old-stock.ts", "export { item } from '@/components/stock/Legacy';\n")
            write(root, "webui/src/components/stock/Legacy.ts", "export const item = 1;\n")
            result = self.run_checker(root)
            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("old stock dependency", result.stderr)

    def test_dynamic_import_and_old_url_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_ts_root(root)
            write(
                root,
                "webui/src/components/stock-vibe/barrel.ts",
                "export const endpoint = '/api/stock/quote';\nexport const load = () => import('@/lib/stock-api');\n",
            )
            write(root, "webui/src/lib/stock-api.ts", "export const endpoint = '/api/stock/quote';\n")
            result = self.run_checker(root)
            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("old stock dependency", result.stderr)
            self.assertIn("old /api/stock/ URL", result.stderr)

    def test_pure_ui_and_new_api_module_are_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_ts_root(root)
            write(root, "webui/src/components/stock-vibe/barrel.ts", "export { Badge } from '@/components/ui/Badge';\n")
            write(root, "webui/src/lib/stock-vibe-api.ts", "export const endpoint = '/api/stock-vibe/watchlist';\n")
            result = self.run_checker(root)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
