from __future__ import annotations

import pytest

from mona.knowledge.compiler import ChangeClassifier
from mona.knowledge.models import ChangePriority, ChangeType


def test_classify_new_file():
    classifier = ChangeClassifier()
    change = classifier.classify("doc.md", old_hash=None, new_hash="h1")
    assert change.type == ChangeType.ADDED
    assert change.priority == ChangePriority.HIGH


def test_classify_minor_change():
    classifier = ChangeClassifier()
    change = classifier.classify("doc.md", old_hash="h0", new_hash="h1", diff_ratio=0.05)
    assert change.type == ChangeType.MODIFIED
    assert change.priority == ChangePriority.LOW


def test_classify_major_change():
    classifier = ChangeClassifier()
    change = classifier.classify("doc.md", old_hash="h0", new_hash="h1", diff_ratio=0.8)
    assert change.type == ChangeType.MODIFIED
    assert change.priority == ChangePriority.HIGH


def test_classify_deleted():
    classifier = ChangeClassifier()
    change = classifier.classify("doc.md", old_hash="h1", new_hash=None)
    assert change.type == ChangeType.DELETED
    assert change.priority == ChangePriority.MEDIUM
