import imaplib
import socket
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from mona.api import server as api
from mona.email.imap_pool import (
    ImapOperationDeferred,
    ImapPoolManager,
    _AccountImapPool,
    _is_permanent_auth_error,
    _is_retryable,
)

RAW_EMAIL = b"From: sender@example.test\r\nSubject: test\r\n\r\nbody"


class FakeImapClient:
    state = "SELECTED"

    def __init__(self):
        self.select_readonly = []
        self.noop_calls = 0
        self.logout_calls = 0
        self.shutdown_calls = 0
        self.sock = FakeSocket()

    def select(self, mailbox, readonly=False):
        self.select_readonly.append(readonly)
        return "OK", []

    def response(self, _name):
        return "UIDVALIDITY", [b"8"]

    def uid(self, operation, *_args):
        if operation == "SEARCH":
            return "OK", [b"42"]
        if operation == "FETCH":
            return "OK", [(b"1 (UID 42 BODY[])", RAW_EMAIL), b")"]
        raise AssertionError(operation)

    def noop(self):
        self.noop_calls += 1
        return "OK", []

    def logout(self):
        self.logout_calls += 1
        return "OK", []

    def shutdown(self):
        self.shutdown_calls += 1


class FakeSocket:
    def __init__(self):
        self.shutdown_modes = []
        self.interrupted = threading.Event()

    def shutdown(self, how):
        self.shutdown_modes.append(how)
        self.interrupted.set()


def _install_fake(monkeypatch, client):
    monkeypatch.setattr(api, "_validate_mail_host", lambda _host: None)
    monkeypatch.setattr(
        api.imap_pool_manager,
        "run",
        lambda _body, operation, *, background=False: operation(client),
    )


def _pool_with_client():
    pool = _AccountImapPool({"imapHost": "mail.example.test", "imapUsername": "reader"})
    client = FakeImapClient()
    pool._client = client
    return pool, client


def test_uid_list_selects_mailbox_readonly(monkeypatch):
    client = FakeImapClient()
    _install_fake(monkeypatch, client)

    result = api._imap_list_uids(
        {"imapHost": "mail.example.test", "imapUsername": "reader", "mailbox": "Archive"}
    )

    assert result["uids"] == ["42"]
    assert client.select_readonly == [True]


def test_raw_export_selects_mailbox_readonly(monkeypatch):
    client = FakeImapClient()
    _install_fake(monkeypatch, client)

    result = api._imap_fetch_raw(
        {
            "imapHost": "mail.example.test",
            "imapUsername": "reader",
            "mailbox": "Archive",
            "uid": "42",
        }
    )

    assert result["size"] == len(RAW_EMAIL)
    assert client.select_readonly == [True]


def test_run_serializes_operations_on_the_single_client():
    pool, client = _pool_with_client()
    first_started = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()
    order = []

    def first(client_arg):
        assert client_arg is client
        order.append("first-start")
        first_started.set()
        assert release_first.wait(2)
        order.append("first-end")

    def second(client_arg):
        assert client_arg is client
        order.append("second-start")
        second_started.set()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(pool.run, first)
        assert first_started.wait(1)
        second_future = executor.submit(pool.run, second)
        assert not second_started.wait(0.05)
        release_first.set()
        first_future.result(timeout=1)
        second_future.result(timeout=1)

    assert order == ["first-start", "first-end", "second-start"]


def test_pool_operation_lock_timeout_does_not_start_or_retry_an_operation():
    pool, _client = _pool_with_client()
    pool._operation_lock_timeout = 0.01
    pool._operation_lock.acquire()
    attempts = []
    try:
        with pytest.raises(RuntimeError, match="邮箱正忙") as error:
            pool.run(lambda _client: attempts.append(True))
    finally:
        pool._operation_lock.release()

    assert attempts == []
    assert not api._is_retryable_error(error.value)


def test_keepalive_skips_a_pool_while_an_operation_holds_its_lock():
    pool, client = _pool_with_client()
    manager = ImapPoolManager()
    pool._operation_lock.acquire()
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(manager._keepalive_pool, pool)
            future.result(timeout=0.5)
    finally:
        pool._operation_lock.release()

    assert client.noop_calls == 0


def test_foreground_can_interrupt_background_read_without_reconnecting():
    manager = ImapPoolManager()
    body = {"imapHost": "mail.example.test", "imapUsername": "reader"}
    pool = manager.get_pool(body)
    client = FakeImapClient()
    pool._client = client
    started = threading.Event()
    attempts = []

    def read(_client):
        attempts.append(True)
        started.set()
        assert client.sock.interrupted.wait(1)
        raise OSError("read interrupted by socket shutdown")

    pool._create_client = lambda: pytest.fail("interrupted background read must not reconnect")
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(manager.run, body, read, background=True)
        assert started.wait(1)
        assert manager.interrupt_background(body)
        with pytest.raises(ImapOperationDeferred):
            future.result(timeout=1)

    assert attempts == [True]
    assert client.sock.shutdown_modes == [socket.SHUT_RDWR]
    assert client.shutdown_calls == 1
    assert pool._client is None
    assert not pool._active_background
    assert not pool._interrupt_event.is_set()


def test_completed_background_read_returns_result_but_discards_interrupted_socket():
    manager = ImapPoolManager()
    body = {"imapHost": "mail.example.test", "imapUsername": "reader"}
    pool = manager.get_pool(body)
    client = FakeImapClient()
    pool._client = client
    started = threading.Event()

    def read(_client):
        started.set()
        assert client.sock.interrupted.wait(1)
        return {"bodyText": "complete"}

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(manager.run, body, read, background=True)
        assert started.wait(1)
        assert manager.interrupt_background(body)
        result = future.result(timeout=1)

    assert result == {"bodyText": "complete"}
    assert client.shutdown_calls == 1
    assert pool._client is None
    assert not pool._active_background
    assert not pool._interrupt_event.is_set()


def test_default_operation_is_not_interrupted():
    manager = ImapPoolManager()
    body = {"imapHost": "mail.example.test", "imapUsername": "reader"}
    pool = manager.get_pool(body)
    client = FakeImapClient()
    pool._client = client
    started = threading.Event()
    release = threading.Event()

    def write(_client):
        started.set()
        assert release.wait(1)
        return "written"

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(manager.run, body, write)
        assert started.wait(1)
        assert not manager.interrupt_background(body)
        assert client.sock.shutdown_modes == []
        release.set()
        assert future.result(timeout=1) == "written"


def test_interrupt_background_does_not_create_a_pool_or_interrupt_without_a_client():
    manager = ImapPoolManager()
    body = {"imapHost": "mail.example.test", "imapUsername": "reader"}

    assert not manager.interrupt_background(body)
    assert manager._pools == {}

    pool = manager.get_pool(body)
    pool._active_background = True
    assert not manager.interrupt_background(body)
    assert pool._interrupt_event.is_set() is False


def test_readonly_select_error_is_a_non_retryable_business_error():
    pool, client = _pool_with_client()
    attempts = []

    def operation(_client):
        attempts.append(True)
        raise imaplib.IMAP4.readonly("mailbox is not writable")

    with pytest.raises(imaplib.IMAP4.readonly):
        pool.run(operation)

    error = imaplib.IMAP4.readonly("mailbox is not writable")
    assert attempts == [True]
    assert not _is_retryable(error)
    assert not api._is_retryable_error(error)
    assert pool._client is client
    assert client.shutdown_calls == 0
    deferred = ImapOperationDeferred("background read was deferred")
    assert not _is_retryable(deferred)
    assert not _is_permanent_auth_error(deferred)
    assert not api._is_retryable_error(deferred)


def test_invalidated_client_uses_local_shutdown_instead_of_logout():
    pool, client = _pool_with_client()

    pool._invalidate()

    assert pool._client is None
    assert client.shutdown_calls == 1
    assert client.logout_calls == 0
