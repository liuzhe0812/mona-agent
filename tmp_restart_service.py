import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)

# Check what's running
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep")
print("Current uvicorn:", stdout.read().decode())

# Kill and restart
stdin, stdout, stderr = ssh.exec_command("pkill -f 'uvicorn app.main:app' 2>&1; sleep 1")
print("Kill:", stdout.read().decode())

# Start fresh
stdin, stdout, stderr = ssh.exec_command("cd /opt/mona-auth && nohup /opt/mona-auth/venv/bin/python3 /opt/mona-auth/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/uvicorn.log 2>&1 &")
print("Start:", stdout.read().decode(), stderr.read().decode())

time.sleep(4)

# Check if running
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep")
print("After restart:", stdout.read().decode())

# Check health
stdin, stdout, stderr = ssh.exec_command("curl -s http://127.0.0.1:8000/health")
print("Health:", stdout.read().decode())

# Check logs if failed
if not stdout.read().decode():
    stdin, stdout, stderr = ssh.exec_command("tail -30 /tmp/uvicorn.log")
    print("Logs:", stdout.read().decode())

ssh.close()
