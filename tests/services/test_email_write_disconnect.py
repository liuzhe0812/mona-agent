import imaplib
from unittest.mock import Mock

import pytest

from mona.api import server
from mona.email.imap_pool import (
    ImapOutcomeUnknown,
    ImapPoolManager,
    _AccountImapPool,
    _is_retryable,
)


@pytest.mark.parametrize("failed_command", ["MOVE", "COPY", "STORE", "EXPUNGE"])
async def test_move_disconnect_does_not_replay_partial_write(monkeypatch, failed_command):
    calls = []

    class Client:
        def select(self, *_args):
            return "OK", []

        def uid(self, command, *_args):
            calls.append(command)
            if command == failed_command:
                raise imaplib.IMAP4.abort("synthetic reply lost")
            return ("BAD" if command == "MOVE" else "OK"), []

        def expunge(self):
            calls.append("EXPUNGE")
            if failed_command == "EXPUNGE":
                raise ConnectionError("synthetic reply lost")
            return "OK", []

    manager = ImapPoolManager()
    body = {"imapHost": "mail.example.test", "imapUsername": "fixture", "uid": "7", "destMailbox": "Archive"}
    pool = manager.get_pool(body)
    monkeypatch.setattr(pool, "_get_or_reconnect", lambda: Client())
    monkeypatch.setattr(pool, "_invalidate", Mock())
    monkeypatch.setattr(server, "imap_pool_manager", manager)
    monkeypatch.setattr(server, "_validate_mail_host", lambda _host: None)
    monkeypatch.setattr(server, "_parse_copyuid_response", lambda _client: None)
    with pytest.raises(ImapOutcomeUnknown) as caught:
        await server._run_imap_locked(body, server._imap_move_message, max_retries=2)
    assert calls.count("MOVE") == 1
    assert calls.count("COPY") <= 1
    assert calls.count(failed_command) == 1
    assert not _is_retryable(caught.value)
    assert not server._is_retryable_error(caught.value)


def test_safe_read_still_retries_once(monkeypatch):
    pool = _AccountImapPool({})
    monkeypatch.setattr(pool, "_get_or_reconnect", lambda: object())
    monkeypatch.setattr(pool, "_invalidate", Mock())
    read = Mock(side_effect=[ConnectionError("synthetic disconnect"), "body"])
    assert pool.run(read) == "body"
    assert read.call_count == 2


def test_write_can_reconnect_before_dispatch(monkeypatch):
    pool = _AccountImapPool({})
    connect = Mock(side_effect=[ConnectionError("synthetic connect failure"), object()])
    monkeypatch.setattr(pool, "_get_or_reconnect", connect)
    monkeypatch.setattr(pool, "_invalidate", Mock())
    write = Mock(return_value="saved")
    assert pool.run(write, retry_on_disconnect=False) == "saved"
    assert connect.call_count == 2
    assert write.call_count == 1
