import paramiko
import os

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)

# Upload modified files
sftp = ssh.open_sftp()

files = [
    ("mona-auth/app/routers/auth_router.py", "/opt/mona-auth/app/routers/auth_router.py"),
    ("mona-auth/app/routers/admin_router.py", "/opt/mona-auth/app/routers/admin_router.py"),
    ("mona-auth/app/admin/index.html", "/opt/mona-auth/app/admin/index.html"),
]

for local, remote in files:
    sftp.put(local, remote)
    print(f"Uploaded: {remote}")

sftp.close()

# Restart service
stdin, stdout, stderr = ssh.exec_command("systemctl restart mona-auth 2>&1 || (cd /opt/mona-auth && pkill -f 'uvicorn app.main:app' && sleep 1 && nohup /opt/mona-auth/venv/bin/python3 venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/uvicorn.log 2>&1 &)")
print("Restart:", stdout.read().decode(), stderr.read().decode())

import time
time.sleep(3)

# Verify service is running
stdin, stdout, stderr = ssh.exec_command("curl -s http://127.0.0.1:8000/health")
print("Health:", stdout.read().decode())

# Test promo-trial endpoint (should return defaults)
stdin, stdout, stderr = ssh.exec_command("curl -s http://127.0.0.1:8000/config/pricing | head -c 100")
print("Pricing still works:", stdout.read().decode())

ssh.close()
print("Done!")
