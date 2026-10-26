"""Small static dependency guard for the stock Vibe integration."""

from __future__ import annotations

import argparse
import ast
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PLATFORM_MODULES = (
    "mona.runtime",
    "mona.config",
    "mona.providers",
    "mona.materials",
    "mona.security",
)
OLD_TOOL_MODULES = {
    "mona.agent.tools.stock_query",
    "mona.agent.tools.stock_research",
    "mona.agent.tools.stock_selection",
    "mona.agent.tools.stock_submit",
    "mona.agent.tools.stock_diagnosis_submit",
}


def _is_under_module(name: str, prefix: str) -> bool:
    return name == prefix or name.startswith(prefix + ".")


def _is_forbidden_module(name: str) -> bool:
    return _is_under_module(name, "mona.services.stock") or any(
        _is_under_module(name, prefix) for prefix in OLD_TOOL_MODULES
    ) or _is_under_module(name, "mona.agent.loop")


def _module_source(root: Path, name: str) -> Path | None:
    path = root.joinpath(*name.split("."))
    for candidate in (path.with_suffix(".py"), path / "__init__.py"):
        if candidate.is_file():
            return candidate.resolve()
    return None


def _is_platform_boundary(name: str) -> bool:
    return any(_is_under_module(name, prefix) for prefix in PLATFORM_MODULES)


def _module_name(root: Path, source: Path) -> str:
    parts = list(source.relative_to(root).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _import_from_names(root: Path, source: Path, node: ast.ImportFrom) -> set[str]:
    if node.level == 0:
        base = node.module or ""
    else:
        package = _module_name(root, source).split(".")
        if source.name != "__init__.py":
            package.pop()
        keep = len(package) - node.level + 1
        if keep < 0:
            return set()
        relative = package[:keep]
        if node.module:
            relative.extend(node.module.split("."))
        base = ".".join(relative)

    names = {base} if base else set()
    for alias in node.names:
        if alias.name == "*":
            continue
        candidate = ".".join(part for part in (base, alias.name) if part)
        if candidate and _module_source(root, candidate):
            names.add(candidate)
    return names


def _literal_string(node: ast.AST | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _dynamic_import_names(tree: ast.AST) -> set[str]:
    importlib_aliases = {"importlib"}
    import_module_aliases: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "importlib":
                    importlib_aliases.add(alias.asname or "importlib")
        elif isinstance(node, ast.ImportFrom) and node.module == "importlib":
            import_module_aliases.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name == "import_module"
            )

    found: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        is_import_module = isinstance(function, ast.Name) and function.id in import_module_aliases
        if isinstance(function, ast.Attribute) and function.attr == "import_module":
            is_import_module = isinstance(function.value, ast.Name) and function.value.id in importlib_aliases
        is_builtin_import = isinstance(function, ast.Name) and function.id == "__import__"
        if not (is_import_module or is_builtin_import) or not node.args:
            continue

        name = _literal_string(node.args[0])
        if name is None:
            continue
        if name.startswith(".") and is_import_module:
            package = _literal_string(node.args[1]) if len(node.args) > 1 else None
            if package is None:
                package_arg = next((kw.value for kw in node.keywords if kw.arg == "package"), None)
                package = _literal_string(package_arg)
            if package:
                try:
                    name = __import__("importlib.util").util.resolve_name(name, package)
                except (ImportError, ValueError):
                    continue
        found.add(name)
    return found


def check_python(root: Path) -> list[str]:
    root = root.resolve()
    seeds: list[Path] = []
    stock_dir = root / "mona" / "services" / "stock_vibe"
    if stock_dir.is_dir():
        seeds.extend(path.resolve() for path in stock_dir.rglob("*.py"))
    bridge = root / "mona" / "api" / "stock_model_bridge.py"
    if bridge.is_file():
        seeds.append(bridge.resolve())

    pending = list(dict.fromkeys(seeds))
    visited: set[Path] = set()
    errors: list[str] = []
    while pending:
        source = pending.pop()
        if source in visited:
            continue
        visited.add(source)
        module = _module_name(root, source)
        if _is_platform_boundary(module):
            continue

        try:
            tree = ast.parse(source.read_text(encoding="utf-8-sig"), filename=str(source))
        except (OSError, SyntaxError) as exc:
            errors.append(f"{source.relative_to(root)}: cannot parse Python source: {exc}")
            continue

        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "process_direct":
                errors.append(f"{source.relative_to(root)}:{node.lineno}: calls AgentLoop.process_direct")

        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.update(_import_from_names(root, source, node))
        imported.update(_dynamic_import_names(tree))

        for name in sorted(imported):
            if _is_forbidden_module(name):
                errors.append(f"{source.relative_to(root)}: forbidden Python dependency {name}")
                continue
            if _is_platform_boundary(name):
                continue
            target = _module_source(root, name)
            if target and target not in visited:
                pending.append(target)

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT, help="Mona repository root")
    args = parser.parse_args()
    root = args.root.resolve()

    errors = check_python(root)
    if errors:
        print("Python stock Vibe boundary violations:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)

    checker = Path(__file__).with_name("check_boundaries.mjs")
    try:
        result = subprocess.run(
            [os.environ.get("NODE", "node"), str(checker), "--root", str(root)],
            check=False,
        )
    except OSError as exc:
        print(f"Could not run TypeScript boundary checker: {exc}", file=sys.stderr)
        return 2
    if errors:
        return 1
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
