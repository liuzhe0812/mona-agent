from __future__ import annotations

import json
from email.message import EmailMessage

import pytest

from mona.api import server as api


def test_sync_repairs_gaps_above_the_oldest_local_uid():
    all_uids = [str(uid).encode() for uid in range(1, 1101)]
    known = {str(uid).encode() for uid in [*range(981, 1001), *range(1051, 1101)]}
    selected, historical, has_more = api._email_sync_uid_batch(all_uids, 1100, 981, known)
    assert selected == [str(uid).encode() for uid in range(1050, 1000, -1)]
    assert historical == set(selected)
    assert has_more


@pytest.mark.asyncio
async def test_account_queue_timeout_does_not_execute_a_waiting_operation(monkeypatch):
    import asyncio

    body = {"imapHost": "mail.example.invalid", "imapUsername": "test"}
    lock = asyncio.Lock()
    await lock.acquire()
    monkeypatch.setattr(api, "_IMAP_LOCKS", {api._imap_lock_key(body): lock})
    monkeypatch.setattr(api, "_IMAP_LOCK_TIMEOUT_SECONDS", 0.01)
    calls = []

    def operation(_body):
        calls.append(True)
        return "ready"

    with pytest.raises(TimeoutError, match="邮箱正忙"):
        await api._run_imap_locked(body, operation, max_retries=0)
    assert calls == []
    assert lock.locked()

    lock.release()
    assert await api._run_imap_locked(body, operation, max_retries=0) == "ready"
    assert calls == [True]


@pytest.mark.asyncio
async def test_foreground_read_overtakes_an_already_queued_background_batch(monkeypatch):
    import asyncio
    import threading

    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    calls = []
    base = {"imapHost": "mail.example.invalid", "imapUsername": "test"}

    def background_batch(body):
        calls.append(body["tag"])
        if body["tag"] == "active":
            loop.call_soon_threadsafe(started.set)
            assert release.wait(2)
        return body["tag"]

    def foreground_read(_body):
        calls.append("foreground")
        return "foreground"

    monkeypatch.setattr(api, "_IMAP_LOCKS", {})
    monkeypatch.setattr(api, "_IMAP_FOREGROUND_WAITERS", {})
    monkeypatch.setattr(api, "_imap_fetch_recent", background_batch)
    monkeypatch.setattr(api.imap_pool_manager, "interrupt_background", lambda _body: False)
    active = asyncio.create_task(api._run_imap_locked({**base, "background": True, "tag": "active"}, background_batch, 0))
    await asyncio.wait_for(started.wait(), 1)
    queued = asyncio.create_task(api._run_imap_locked({**base, "background": True, "tag": "queued"}, background_batch, 0))
    await asyncio.sleep(0)
    foreground = asyncio.create_task(api._run_imap_locked(base, foreground_read, 0))
    await asyncio.sleep(0)
    release.set()
    await asyncio.wait_for(asyncio.gather(active, queued, foreground), 2)

    assert calls == ["active", "foreground", "queued"]
    assert api._IMAP_FOREGROUND_WAITERS == {}


@pytest.mark.asyncio
async def test_cancelled_foreground_waiter_does_not_block_background_work(monkeypatch):
    import asyncio

    body = {"imapHost": "mail.example.invalid", "imapUsername": "test"}
    key = api._imap_lock_key(body)
    lock = asyncio.Lock()
    await lock.acquire()
    monkeypatch.setattr(api, "_IMAP_LOCKS", {key: lock})
    monkeypatch.setattr(api, "_IMAP_FOREGROUND_WAITERS", {})
    monkeypatch.setattr(api.imap_pool_manager, "interrupt_background", lambda _body: False)

    def operation(_body):
        return "ready"

    monkeypatch.setattr(api, "_imap_fetch_recent", operation)
    pending = asyncio.create_task(api._run_imap_locked(body, operation, 0))
    await asyncio.sleep(0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert api._IMAP_FOREGROUND_WAITERS == {}
    assert lock.locked()
    lock.release()
    assert await api._run_imap_locked({**body, "background": True}, operation, 0) == "ready"


@pytest.mark.asyncio
async def test_foreground_interrupts_a_background_read_that_starts_after_it_arrives(monkeypatch):
    import asyncio
    import threading

    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    allow_background = threading.Event()
    background_active = threading.Event()
    interrupted = threading.Event()
    attempts = []
    base = {"imapHost": "mail.example.invalid", "imapUsername": "test"}

    def background_read(_body):
        loop.call_soon_threadsafe(started.set)
        assert allow_background.wait(2)
        background_active.set()
        assert interrupted.wait(2)
        raise api.ImapOperationDeferred("后台收取已暂缓，稍后继续。")

    def interrupt(_body):
        attempts.append(True)
        if len(attempts) == 1:
            allow_background.set()
            return False
        if background_active.is_set():
            interrupted.set()
            return True
        return False

    monkeypatch.setattr(api, "_IMAP_LOCKS", {})
    monkeypatch.setattr(api, "_IMAP_FOREGROUND_WAITERS", {})
    monkeypatch.setattr(api, "_imap_fetch_body", background_read)
    monkeypatch.setattr(api.imap_pool_manager, "interrupt_background", interrupt)
    background = asyncio.create_task(api._run_imap_locked({**base, "background": True}, background_read, 0))
    await asyncio.wait_for(started.wait(), 1)
    foreground = asyncio.create_task(api._run_imap_locked(base, lambda _body: "ready", 0))
    results = await asyncio.wait_for(asyncio.gather(background, foreground, return_exceptions=True), 3)
    assert isinstance(results[0], api.ImapOperationDeferred)
    assert results[1] == "ready"
    assert len(attempts) >= 2
    assert api._IMAP_FOREGROUND_WAITERS == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("handler_name", [
    "handle_email_sync", "handle_email_list_uids", "handle_email_fetch_body",
    "handle_email_fetch_attachment", "handle_email_fetch_raw",
])
async def test_background_read_deferred_response_is_explicit(monkeypatch, handler_name):
    async def deferred(_body, _func, max_retries=1):
        raise api.ImapOperationDeferred("后台收取已暂缓，稍后继续。")

    class Request:
        async def json(self):
            return {"background": True}

    monkeypatch.setattr(api, "_run_imap_locked", deferred)
    response = await getattr(api, handler_name)(Request())
    assert response.status == 409
    assert json.loads(response.body) == {"deferred": True}


def test_sync_short_batches_resume_without_skipping_uids(monkeypatch):
    clock = [100.0]

    class SlowMailbox(Mailbox):
        def uid(self, operation, *args):
            result = super().uid(operation, *args)
            if operation == "FETCH" and args[1] != "(UID FLAGS)":
                clock[0] += 1.1
            return result

    body = mailbox(monkeypatch, SlowMailbox(5))
    monkeypatch.setattr(api.time, "monotonic", lambda: clock[0])
    saved = set()
    pages = []
    for _ in range(5):
        result = api._imap_fetch_recent(body)
        page = [int(message["uid"]) for message in result["messages"]]
        pages.append(page)
        saved.update(page)
        if not result["hasMore"]:
            break
        body.update(lastUid=str(max(saved)), beforeUid=str(min(saved)), uidValidity="8")
    assert pages == [[5, 4], [3, 2], [1]]
    assert saved == {1, 2, 3, 4, 5}


def test_only_read_operations_forward_background_priority_to_the_pool(monkeypatch):
    client = Mailbox(1)
    body = mailbox(monkeypatch, client)
    priorities = []

    def run(_body, operation, *, background=False):
        priorities.append(background)
        return operation(client)

    monkeypatch.setattr(api.imap_pool_manager, "run", run)
    result = api._imap_fetch_body({**body, "uid": "1", "background": True})
    assert result["bodyText"] == "body"
    api._imap_set_flag({**body, "uid": "1", "flag": "\\Seen", "add": True, "background": True})
    assert priorities == [True, False]


class Mailbox:
    def __init__(self, count=65, raw=None):
        self.uids = [str(n).encode() for n in range(1, count + 1)]
        self.raw = raw
        self.select_readonly = []

    def select(self, _mailbox, readonly=False):
        self.select_readonly.append(readonly)
        return "OK", [str(len(self.uids)).encode()]

    def response(self, _name):
        return "UIDVALIDITY", [b"8"]

    def uid(self, operation, *args):
        if operation == "SEARCH":
            return "OK", [b" ".join(self.uids)]
        if operation == "FETCH" and args[1] == "(UID FLAGS)":
            return "OK", [b"1 (UID " + uid + b" FLAGS (\\Flagged))" for uid in args[0].encode().split(b",")]
        if operation == "FETCH":
            uid = str(args[0]).encode()
            raw = self.raw or b"From: sender@example.test\r\nSubject: item\r\n\r\nbody"
            return "OK", [(b"1 (UID " + uid + b" FLAGS () RFC822.SIZE 100)", raw)]
        if operation == "STORE":
            return "OK", []
        raise AssertionError((operation, args))


def mailbox(monkeypatch, client):
    monkeypatch.setattr(api, "_validate_mail_host", lambda _host: None)
    monkeypatch.setattr(
        api.imap_pool_manager,
        "run",
        lambda _body, op, *, background=False: op(client),
    )
    return {"imapHost": "mail.example.test", "imapUsername": "reader", "mailbox": "INBOX"}


def test_sync_backfills_all_history_without_announcing_it_as_new_mail(monkeypatch):
    client = Mailbox(135)
    body = mailbox(monkeypatch, client)
    saved = set()
    for _ in range(10):
        result = api._imap_fetch_recent(body)
        saved.update(int(message["uid"]) for message in result["messages"])
        assert all(message["isHistorical"] for message in result["messages"])
        if not result["hasMore"]:
            break
        body.update(lastUid=str(max(saved)), beforeUid=str(min(saved)), uidValidity="8")
    assert saved == set(range(1, 136))
    assert client.select_readonly and all(client.select_readonly)


def test_incremental_batches_do_not_skip_the_first_new_messages():
    uids = [str(n).encode() for n in range(1, 141)]
    selected, historical, more = api._email_sync_uid_batch(uids, 50, 1)
    assert selected == [str(n).encode() for n in range(51, 101)]
    assert not historical
    assert more


def test_sync_returns_existing_remote_flags_including_cleared_read_state(monkeypatch):
    client = Mailbox(3)
    body = mailbox(monkeypatch, client)
    result = api._imap_fetch_recent({**body, "lastUid": "3", "beforeUid": "1", "uidValidity": "8"})
    assert result["messages"] == []
    assert result["flags"] == [{"uid": str(n), "isRead": False, "isStarred": True} for n in range(1, 4)]
    assert client.select_readonly == [True]


def test_full_body_keeps_long_unicode_content(monkeypatch):
    text = "正文内容" * 20000 + "最后一段"
    message = EmailMessage()
    message.set_content(text)
    client = Mailbox(1, message.as_bytes())
    body = mailbox(monkeypatch, client)
    result = api._imap_fetch_body({**body, "uid": "1"})
    assert result["bodyText"].rstrip() == text
    assert result["rawBytes"]
    assert client.select_readonly == [True]


@pytest.mark.parametrize("stage", ["select", "STORE"])
def test_flag_rejection_is_not_reported_as_success(monkeypatch, stage):
    client = Mailbox(1)
    body = mailbox(monkeypatch, client)
    if stage == "select":
        def reject_select(_name, readonly=False):
            client.select_readonly.append(readonly)
            return "NO", []

        monkeypatch.setattr(client, "select", reject_select)
    else:
        monkeypatch.setattr(client, "uid", lambda *_args: ("NO", []))
    with pytest.raises(RuntimeError):
        api._imap_set_flag({**body, "uid": "1", "flag": "\\Seen", "add": False})
    assert client.select_readonly == [False]


async def test_unknown_smtp_attempt_is_not_retried(monkeypatch):
    attempts = []

    def uncertain(_body):
        attempts.append(True)
        raise ConnectionResetError("connection ended after dispatch")

    monkeypatch.setattr(api, "_smtp_send_message_no_append", uncertain)

    class Request:
        app = {}

        async def json(self):
            return {}

    response = await api.handle_email_send(Request())
    assert len(attempts) == 1
    assert json.loads(response.body)["sendState"] == "unknown"


def test_history_page_does_not_repeatedly_fetch_known_flags(monkeypatch):
    from mona.api import server

    header = b"Subject: History\r\nMessage-ID: <history@example.invalid>\r\n\r\n"

    class Client:
        def __init__(self):
            self.select_readonly = []

        def select(self, mailbox, readonly=False):
            self.select_readonly.append(readonly)
            return "OK", [b"2"]

        def response(self, name):
            return name, [b"1"]

        def uid(self, command, *args):
            if command == "SEARCH":
                return "OK", [b"1 2"]
            assert args[1] != "(UID FLAGS)"
            return "OK", [(b"1 (UID 1 FLAGS () RFC822.SIZE 100)", header)]

    monkeypatch.setattr(server, "_validate_mail_host", lambda host: None)
    client = Client()
    monkeypatch.setattr(
        server.imap_pool_manager,
        "run",
        lambda body, operation, *, background=False: operation(client),
    )
    result = server._imap_fetch_recent({
        "imapHost": "mail.example.invalid", "imapUsername": "test",
        "lastUid": "2", "beforeUid": 2, "refreshFlags": False,
    })
    assert [message["uid"] for message in result["messages"]] == ["1"]
    assert result["flags"] == []
    assert client.select_readonly == [True]
