import pytest

from mona.knowledge.models import KnowledgeMeta, KnowledgeMode
from mona.knowledge.store import KnowledgeStore


@pytest.fixture()
def store(tmp_path):
    return KnowledgeStore(tmp_path / "kb", KnowledgeMode.DOCUMENT)


def test_store_init_creates_dirs(store):
    store.ensure_dirs()
    assert store.root.is_dir()
    assert store.wiki_dir.is_dir()


def test_store_meta_roundtrip(store):
    store.ensure_dirs()
    meta = KnowledgeMeta(mode=KnowledgeMode.DOCUMENT)
    store.save_meta(meta)
    loaded = store.load_meta()
    assert loaded.mode == KnowledgeMode.DOCUMENT


def test_store_meta_default_when_missing(store):
    store.ensure_dirs()
    loaded = store.load_meta()
    assert loaded.mode == KnowledgeMode.DOCUMENT


def test_store_wiki_dir_exists_for_document_mode(tmp_path):
    store = KnowledgeStore(tmp_path / "kb", KnowledgeMode.DOCUMENT)
    store.ensure_dirs()
    assert store.wiki_dir.is_dir()


def test_store_no_wiki_dir_for_notebook_mode(tmp_path):
    store = KnowledgeStore(tmp_path / "kb", KnowledgeMode.NOTEBOOK)
    store.ensure_dirs()
    assert store.root.is_dir()
    assert not store.wiki_dir.exists()
