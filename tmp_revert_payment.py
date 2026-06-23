import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)

sftp = ssh.open_sftp()
sftp.put("mona-auth/app/routers/payment_router.py", "/opt/mona-auth/app/routers/payment_router.py")
print("Uploaded payment_router.py (reverted)")
sftp.close()

stdin, stdout, stderr = ssh.exec_command("pkill -f 'uvicorn app.main:app'; sleep 1")
stdout.read()

stdin, stdout, stderr = ssh.exec_command(
    "cd /opt/mona-auth && nohup /opt/mona-auth/venv/bin/python3 /opt/mona-auth/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/uvicorn.log 2>&1 &"
)
stdout.read()
time.sleep(3)

stdin, stdout, stderr = ssh.exec_command("curl -s --connect-timeout 3 http://127.0.0.1:8000/health")
print("Health:", stdout.read().decode())

ssh.close()
