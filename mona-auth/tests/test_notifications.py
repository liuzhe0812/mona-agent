def test_notifications_require_auth(client):
    res = client.get("/notifications")
    assert res.status_code == 401


def test_list_notifications(client, admin_user, db):
    from app.models import Notification

    n = Notification(title="Test", body="Body", type="system", published=True)
    db.add(n)
    db.commit()
    login = client.post("/auth/login", json={"account": admin_user.account, "password": "admin123"})
    assert login.status_code == 200
    token = login.json()["access_token"]
    res = client.get("/notifications", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert len(res.json()["notifications"]) == 1
