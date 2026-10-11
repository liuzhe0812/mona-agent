"""Execute the actual SDK collection block without building the whole desktop."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from mona.development.executors.sdk_policy import SDK_MODULES, SDK_PACKAGES


def collection_block():
    path = Path(__file__).resolve().parents[2] / "mona-gateway.spec"
    tree = ast.parse(path.read_text(encoding="utf8"), filename=str(path))
    node = next(n for n in tree.body if isinstance(n, ast.For) and isinstance(n.iter, ast.Call)
                and isinstance(n.iter.func, ast.Attribute) and isinstance(n.iter.func.value, ast.Name)
                and n.iter.func.value.id == "SDK_MODULES")
    return compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec")


def test_sdk_python_and_metadata_ship_without_a_second_native_binary():
    checked = []
    def collect(module):
        native_directory = "_bundled" if module == "claude_agent_sdk" else "bin"
        native_module = module + "._bundled" if module == "claude_agent_sdk" else module + ".bin"
        return ([(f"/{module}/LICENSE", module),
                 (f"/{module}/{native_directory}/agent.exe", f"{module}/{native_directory}")],
                [(f"/{module}/{native_directory}/agent.exe", f"{module}/{native_directory}")],
                [module, module + ".client", native_module])
    def metadata(package, recursive=False):
        assert recursive
        return [(f"/{package}.dist-info", f"{package}.dist-info")]
    env = {"Path": Path, "SDK_MODULES": SDK_MODULES, "SDK_PACKAGES": SDK_PACKAGES,
           "sdk_version": checked.append, "collect_all": collect, "copy_metadata": metadata,
           "datas": [], "binaries": [], "hiddenimports": []}
    exec(collection_block(), env)
    assert set(checked) == set(SDK_MODULES)
    assert not env["binaries"]
    assert all(
        not any(path in str(row).replace("\\", "/")
                for path in ("claude_agent_sdk/_bundled", "codebuddy_agent_sdk/bin"))
        for row in env["datas"] + env["hiddenimports"]
    )
    for module in SDK_MODULES.values():
        assert module + ".client" in env["hiddenimports"]
    for package in SDK_PACKAGES.values():
        assert (f"/{package}.dist-info", f"{package}.dist-info") in env["datas"]


def test_missing_required_sdk_fails_build_instead_of_shipping_dead_entry():
    def unavailable(_executor):
        raise RuntimeError("official SDK absent")
    with pytest.raises(RuntimeError, match="official SDK absent"):
        exec(collection_block(), {"SDK_MODULES": SDK_MODULES, "sdk_version": unavailable})
