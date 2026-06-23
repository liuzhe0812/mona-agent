import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)

# Check uvicorn log for errors
stdin, stdout, stderr = ssh.exec_command("tail -30 /tmp/uvicorn.log 2>&1")
print("=== uvicorn log ===")
print(stdout.read().decode())

# Check if process is running
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep")
print("=== running processes ===")
print(stdout.read().decode())

# Try health check
stdin, stdout, stderr = ssh.exec_command("curl -s --connect-timeout 3 http://127.0.0.1:8000/health 2>&1")
print("=== health check ===")
print(stdout.read().decode())

ssh.close()
