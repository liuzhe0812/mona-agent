def test_get_pricing_config(client):
    res = client.get("/config/pricing")
    assert res.status_code == 200
    data = res.json()
    assert "plans" in data
    assert "contact" in data
    assert data["contact"]["email"]
