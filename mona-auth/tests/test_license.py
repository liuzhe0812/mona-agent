from app.license import issue_license, verify_license


class TestLicense:
    def test_issue_and_verify(self):
        token, exp = issue_license(user_id=1, device_fingerprint="fp123")
        payload = verify_license(token, "fp123")
        assert payload is not None
        assert payload["sub"] == "user_id:1"
        assert payload["plan"] == "pro"

    def test_verify_wrong_fingerprint(self):
        token, _ = issue_license(user_id=1, device_fingerprint="fp123")
        payload = verify_license(token, "fp456")
        assert payload is None

    def test_verify_expired(self):
        import jwt as pyjwt
        from datetime import datetime, timedelta, timezone

        from app.config import settings

        now = datetime.now(timezone.utc)
        payload = {
            "sub": "user_id:1",
            "fp": "abc",
            "plan": "pro",
            "exp": now - timedelta(hours=1),
            "iat": now - timedelta(hours=2),
            "jti": "test",
        }
        expired_token = pyjwt.encode(payload, settings.license_private_key, algorithm="RS256")
        result = verify_license(expired_token, "fp_not_checked_due_to_expiry")
        assert result is None

    def test_verify_tampered_payload(self):
        token, _ = issue_license(user_id=1, device_fingerprint="fp123")
        parts = token.split(".")
        import base64
        import json

        payload_b64 = parts[1]
        pad = "=" * (-len(payload_b64) % 4)
        payload_json = base64.urlsafe_b64decode(payload_b64 + pad)
        payload_dict = json.loads(payload_json)
        payload_dict["plan"] = "admin"
        new_payload = base64.urlsafe_b64encode(
            json.dumps(payload_dict).encode()
        ).rstrip(b"=")
        parts[1] = new_payload.decode()
        tampered_token = ".".join(parts)
        result = verify_license(tampered_token, "fp123")
        assert result is None
