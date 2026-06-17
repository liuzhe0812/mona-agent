---
name: "server-ops"
description: "Manage Mona VPS server: deploy code, run migrations, restart services, view logs, sync files. Invoke when user asks to deploy, update server, run migration, restart service, check logs, or any server maintenance task."
---

# Mona Server Operations

Manage the Mona production VPS and its services.

## VPS Connection

| Field | Value |
|-------|-------|
| Host | `47.117.69.105` |
| User | `root` |
| Password | `Alt34484!@#` |
| Domain | `mona.lzfun.vip` |

**Connection method:** Use Python `paramiko` (Windows lacks native sshpass). Always write a `.py` script to `/tmp/` on VPS for multi-line operations to avoid PowerShell escaping issues.

```python
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)
sftp = ssh.open_sftp()

# For simple commands:
stdin, stdout, stderr = ssh.exec_command("command")
print(stdout.read().decode())

# For complex Python operations, write script to VPS first:
with sftp.open("/tmp/ops.py", "w") as f:
    f.write(script_content)
stdin, stdout, stderr = ssh.exec_command("cd /opt/mona-auth && /opt/mona-auth/venv/bin/python /tmp/ops.py")

sftp.close()
ssh.close()
```

## Services

| Service | Path | Process | Port |
|---------|------|---------|------|
| mona-auth | `/opt/mona-auth/` | uvicorn | 8000 |
| Nginx | `/etc/nginx/` | nginx | 80/443 |
| MySQL | Default | mysqld | 3306 |

### Service Management

```bash
# Find mona-auth process
ps aux | grep mona-auth | grep -v grep

# Restart mona-auth (find PID first, then kill -HUP for graceful restart)
kill -HUP <PID>

# Or force restart
pkill -f "uvicorn app.main:app" && cd /opt/mona-auth && nohup /opt/mona-auth/venv/bin/python3 venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 &

# Nginx
nginx -t && nginx -s reload
```

## Database

| Field | Value |
|-------|-------|
| Host | `127.0.0.1` (on VPS) |
| Port | `3306` |
| User | `root` |
| Password | `alt34484` |
| Database | `mona_auth` |
| Connection string | `mysql+pymysql://root:alt34484@127.0.0.1:3306/mona_auth` |

### Run Alembic Migration

```bash
cd /opt/mona-auth && /opt/mona-auth/venv/bin/alembic upgrade head
```

If migration fails partway through, clean up and retry:

```python
from app.database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
for stmt in ["DROP TABLE IF EXISTS <table>", "DELETE FROM alembic_version"]:
    db.execute(text(stmt))
db.commit()
db.close()
```

### Direct SQL Queries

```python
from app.database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
rows = db.execute(text("SELECT * FROM table_name")).fetchall()
for r in rows: print(r)
db.close()
```

## Deploy Code Updates

### Sync mona-auth Files

Upload changed Python files to VPS, then restart the service:

```python
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)
sftp = ssh.open_sftp()

files = [
    ("mona-auth/app/models.py", "/opt/mona-auth/app/models.py"),
    ("mona-auth/app/schemas.py", "/opt/mona-auth/app/schemas.py"),
    # ... add more as needed
]
for local, remote in files:
    sftp.put(local, remote)
    print(f"Uploaded: {local}")

sftp.close()

# Restart service
stdin, stdout, stderr = ssh.exec_command("pkill -HUP -f 'uvicorn app.main:app'")
print(stdout.read().decode())

ssh.close()
```

### Full Sync (all mona-auth files)

```python
# Upload entire app directory
for root, dirs, files in os.walk("mona-auth/app"):
    for f in files:
        if f.endswith(".py") or f.endswith(".html"):
            local = os.path.join(root, f)
            remote = local.replace("mona-auth", "/opt/mona-auth", 1).replace("\\", "/")
            sftp.put(local, remote)
```

## Key Paths on VPS

| Path | Purpose |
|------|---------|
| `/opt/mona-auth/` | mona-auth application |
| `/opt/mona-auth/venv/` | Python virtual environment |
| `/opt/mona-auth/alembic/` | Database migrations |
| `/opt/mona-auth/app/admin/index.html` | Admin panel |
| `/var/www/mona/dist/` | Official website (SPA) |
| `/var/www/mona/updates/update.json` | Hot-update manifest |
| `/var/www/mona/releases/` | Release packages |
| `/etc/nginx/conf.d/mona.conf` | Nginx config |
| `/etc/nginx/conf.d/mona-auth.conf` | mona-auth proxy config |

## API Verification

```bash
# Test mona-auth API locally on VPS
curl -s http://127.0.0.1:8000/config/pricing

# Test via public domain
curl -s https://mona.lzfun.vip/config/pricing

# Test admin panel
curl -s https://mona.lzfun.vip/admin/ | head -5
```

## Quick Reference

| User says | Action |
|-----------|--------|
| "部署后端" / "deploy backend" | Sync mona-auth files to VPS + restart service |
| "跑迁移" / "run migration" | Upload migration file + `alembic upgrade head` |
| "重启服务" / "restart service" | Find and restart uvicorn process |
| "看日志" / "check logs" | `tail -f /var/log/...` or check uvicorn output |
| "同步代码" / "sync code" | Upload changed files via paramiko SFTP |
| "查看数据库" / "check database" | Run SQL query via Python on VPS |
| "更新配置" / "update config" | Edit config on VPS + restart service |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| SSH connection fails | Check VPS is up: `ping 47.117.69.105` |
| alembic `version_num` too long | Use short revision IDs (max 32 chars) |
| Foreign key constraint error | Ensure FK column types match (BigInteger vs Integer) |
| `bulk_insert` fails with `'str' has no attribute 'insert'` | Use `sa.table()` instead of string for first arg |
| Service not responding after restart | Check process: `ps aux \| grep uvicorn`, check port: `ss -tlnp \| grep 8000` |
| MySQL connection refused | Check mysqld is running: `systemctl status mysqld` |
| Nginx 502 | Check uvicorn is running on port 8000 |
