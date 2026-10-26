"""Catalog display caching must not cache execution identities or user assets."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]

_PROBE = r'''
import json
from dataclasses import replace
from unittest.mock import patch

from fastapi import HTTPException
from src.api import mona_strategy_library as library
from src.strategy_store._shared import get_store
from src.strategy_store.models import Artifact, ArtifactStatus, ArtifactType, MONA_DELETED_STRATEGY_PREFIX

store = get_store()
first_id = store.register_artifact(Artifact(id='', type=ArtifactType.STRATEGY,
    name='Custom draft 1', universe='equity_cn', signal_definition='First saved rule'))
second_id = store.register_artifact(Artifact(id='', type=ArtifactType.STRATEGY,
    name='Custom draft 2', universe='crypto', signal_definition='Second saved rule'))

# The real source reader and AST metadata extraction run on the first catalog only.
with patch.object(library, '_artifacts', side_effect=AssertionError('built-in filter read SDM')), \
        patch.object(library.ast, 'parse', wraps=library.ast.parse) as parse:
    builtin = library.strategy_catalog(source='builtin')
    first_parse_count = parse.call_count
    assert builtin['total'] == 20 and first_parse_count > 0
    expected = json.loads(json.dumps(builtin))
    builtin['items'][0]['name'] = 'caller mutation'
    builtin['items'][0]['rules'][0]['value'] = 'nested caller mutation'
    builtin['items'][0]['parameters'][0]['value'] = -999
    again = library.strategy_catalog(source='builtin')
    assert again == expected and parse.call_count == first_parse_count
    assert library.strategy_catalog(source='builtin', q='多因子')['total'] == 1
    assert parse.call_count == first_parse_count

# Custom catalog reads still use the actual native store and fresh strategy details.
with patch.object(library, '_builtin_entries', side_effect=AssertionError('custom filter read built-ins')), \
        patch.object(library, '_builtin_code', side_effect=AssertionError('custom filter read built-in source')):
    custom = library.strategy_catalog(source='custom')
assert {row['strategy_id'] for row in custom['items']} == {'sdm:' + first_id, 'sdm:' + second_id}
combined = library.strategy_catalog()
assert combined['items'] == expected['items'] + custom['items']
assert combined['total'] == 22
filtered = [row for row in combined['items'] if row['market'] == 'china_a']
page = library.strategy_catalog(limit=2, offset=1, market='china_a')
assert page['items'] == filtered[1:3] and page['total'] == len(filtered)
assert library.strategy_catalog(source='custom', q='Second saved')['items'] == [
    row for row in custom['items'] if row['strategy_id'] == 'sdm:' + second_id]

before = library.strategy_detail('sdm:' + first_id)
store.update_artifact(replace(store.get_artifact(first_id), name='Renamed custom', signal_definition='Updated rule'))
after = next(row for row in library.strategy_catalog(source='custom')['items'] if row['strategy_id'] == 'sdm:' + first_id)
assert after['version'] != before['version'] and after['name'] == 'Renamed custom'
assert after['description'] == 'Updated rule'
store.update_status(first_id, ArtifactStatus.DISABLED, reason=MONA_DELETED_STRATEGY_PREFIX + after['version'])
assert library.strategy_catalog(source='custom')['total'] == 1
assert library.strategy_detail('sdm:' + first_id)['deleted'] is True

# A cached display row must never satisfy validation after the actual source changes.
identity = 'builtin:multi-factor'
cached = next(row for row in library.strategy_catalog(source='builtin')['items'] if row['strategy_id'] == identity)
source = library._AGENT / 'src/skills/multi-factor/example_signal_engine.py'
original = source.read_bytes()
try:
    source.write_bytes(b'# changed source for identity regression\n' + original)
    fresh = library.strategy_detail(identity)
    assert fresh['version'] != cached['version']
    assert next(row for row in library.strategy_catalog(source='builtin')['items'] if row['strategy_id'] == identity)['version'] == cached['version']
    try:
        library.validate_strategy_operation({'operation': 'strategy_scan', 'strategy_id': identity,
            'strategy_version': cached['version']})
    except HTTPException as error:
        assert error.status_code == 409
    else:
        raise AssertionError('display cache bypassed current execution identity')
finally:
    source.write_bytes(original)

print(json.dumps({'builtin_source_skips_sdm': True, 'custom_source_skips_builtin': True,
    'builtin_ast_parsed_once': True, 'defensive_copy': True,
    'custom_updates_and_deletes_fresh': True, 'filter_pagination_preserved': True,
    'execution_reads_current_builtin_source': True}))
'''


def test_native_catalog_filters_and_display_cache_preserve_execution_checks(tmp_path: Path) -> None:
    python = Path(os.environ.get("MONA_VIBE_TEST_PYTHON", str(ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe")))
    if not python.is_file():
        pytest.skip("explicit native Vibe Python environment required")
    source = tmp_path / "source"
    prepare(ROOT / "third_party/vibe-trading", source)
    home = tmp_path / "home"
    home.mkdir()
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    }}
    env.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1", HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(python), "-c", _PROBE], cwd=home, env=env,
        capture_output=True, text=True, encoding="utf-8", timeout=45, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
