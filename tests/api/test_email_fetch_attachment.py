import base64
from email import policy
from email.parser import BytesParser

from mona.api import server as api

RAW_EMAIL = b"""\
MIME-Version: 1.0
Content-Type: multipart/related; boundary="mail-boundary"

--mail-boundary
Content-Type: image/png
Content-Disposition: inline; filename="shared.bin"
Content-ID: <logo@example.test>
Content-Transfer-Encoding: base64

aW5saW5lLWltYWdl
--mail-boundary
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="shared.bin"
Content-Transfer-Encoding: base64

cmVndWxhci1hdHRhY2htZW50
--mail-boundary--
"""


def test_imap_fetch_attachment_prefers_content_id_over_same_filename(monkeypatch):
    class FakeImapClient:
        def __init__(self):
            self.select_readonly = []

        def select(self, _mailbox, readonly=False):
            self.select_readonly.append(readonly)
            return "OK", []

        def uid(self, *_args):
            return "OK", [(b"1 (BODY[] {raw}", RAW_EMAIL), b")"]

    client = FakeImapClient()
    monkeypatch.setattr(api, "_validate_mail_host", lambda _host: None)
    monkeypatch.setattr(
        api.imap_pool_manager,
        "run",
        lambda _body, operation, *, background=False: operation(client),
    )
    request = {
        "imapHost": "mail.example.test",
        "imapUsername": "reader@example.test",
        "uid": "17",
        "filename": "shared.bin",
        "contentId": "logo@example.test",
    }

    inline_result = api._imap_fetch_attachment(request)
    assert base64.b64decode(inline_result["data"]) == b"inline-image"
    assert inline_result["contentType"] == "image/png"
    assert inline_result["filename"] == "shared.bin"
    assert client.select_readonly == [True]

    legacy_result = api._imap_fetch_attachment({**request, "contentId": None})
    assert base64.b64decode(legacy_result["data"]) == b"regular-attachment"
    assert legacy_result["contentType"] == "application/octet-stream"
    assert set(legacy_result) == {"filename", "contentType", "size", "data"}
    assert client.select_readonly == [True, True]


def test_body_attachment_metadata_retains_inline_cid_without_counting_it_as_attachment():
    parsed = BytesParser(policy=policy.default).parsebytes(RAW_EMAIL)
    attachments = api._email_extract_attachments(parsed)

    assert attachments[0]["contentId"] == "logo@example.test"
    assert attachments[0]["isInline"] is True
    assert attachments[1]["isInline"] is False

    inline_only = RAW_EMAIL.split(
        b"--mail-boundary\nContent-Type: application/octet-stream", maxsplit=1
    )[0] + b"--mail-boundary--\n"
    inline_message = BytesParser(policy=policy.default).parsebytes(inline_only)
    assert api._email_extract_attachments(inline_message)[0]["isInline"] is True
    assert api._email_has_attachments(inline_message) is False
