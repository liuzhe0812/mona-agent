"""Deploy mona-auth to remote server via SSH/SCP."""
import paramiko
import os
import sys
import secrets
from pathlib import Path
from scp import SCPClient

HOST = "47.117.69.105"
USER = "root"
PASS = "Alt34484!@#"
REMOTE_DIR = "/opt/mona-auth"
LOCAL_DIR = str(Path(__file__).parent / "mona-auth")

def ssh_connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=15)
    return client

def run(client, cmd, check=True):
    print(f">>> {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
    out = stdout.read().decode()
    err = stderr.read().decode()
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.strip()[-2000:])
    if err.strip() and code != 0:
        print(f"STDERR: {err.strip()[-1000:]}")
    if check and code != 0:
        raise RuntimeError(f"Command failed (exit {code}): {cmd}")
    return out, err, code

def main():
    print(f"Connecting to {HOST}...")
    client = ssh_connect()
    print("Connected!")

    # 1. Check environment
    print("\n=== Checking environment ===")
    run(client, "python3 --version")
    run(client, "mysql --version", check=False)
    run(client, "which pm2 || echo 'pm2 not found'")

    # 2. Create database and user
    print("\n=== Creating database ===")
    db_pass = secrets.token_urlsafe(16)
    run(client, f"mysql -e \"CREATE DATABASE IF NOT EXISTS mona_auth CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\"")
    run(client, f"mysql -e \"CREATE USER IF NOT EXISTS 'mona_auth'@'127.0.0.1' IDENTIFIED BY '{db_pass}';\"")
    run(client, f"mysql -e \"GRANT ALL PRIVILEGES ON mona_auth.* TO 'mona_auth'@'127.0.0.1'; FLUSH PRIVILEGES;\"")

    # 3. Upload code
    print("\n=== Uploading code ===")
    run(client, f"rm -rf {REMOTE_DIR} && mkdir -p {REMOTE_DIR}")
    
    # Upload via SCP
    def progress(filename, size, sent):
        if sent == size:
            print(f"  Uploaded: {filename}")

    with SCPClient(client.get_transport(), progress=progress) as scp:
        local = Path(LOCAL_DIR)
        # Upload app directory
        for f in local.rglob("*"):
            if f.is_file():
                rel = f.relative_to(local)
                # Skip __pycache__, .env, venv, keys
                parts = rel.parts
                if any(p in parts for p in ["__pycache__", "venv", ".env", "keys", ".git", "node_modules", ".ruff_cache"]):
                    continue
                remote_path = f"{REMOTE_DIR}/{rel.as_posix()}"
                remote_dir = "/".join(remote_path.split("/")[:-1])
                run(client, f"mkdir -p {remote_dir}", check=False)
                scp.put(str(f), remote_path)
    
    print("  Code uploaded!")

    # 4. Generate .env
    print("\n=== Configuring .env ===")
    jwt_secret = secrets.token_urlsafe(32)
    env_content = f"""MONA_AUTH_DATABASE_URL=mysql+pymysql://mona_auth:{db_pass}@127.0.0.1:3306/mona_auth
MONA_AUTH_JWT_ACCESS_SECRET={jwt_secret}
MONA_AUTH_CORS_ORIGINS=["http://localhost:1420","tauri://localhost"]
MONA_AUTH_TRIAL_DAYS=31
"""
    # Write .env via SSH
    run(client, f"cat > {REMOTE_DIR}/.env << 'ENVEOF'\n{env_content}ENVEOF")

    # 5. Setup virtual environment and install deps
    print("\n=== Installing dependencies ===")
    run(client, f"cd {REMOTE_DIR} && python3 -m venv venv")
    run(client, f"cd {REMOTE_DIR} && venv/bin/pip install .")

    # 6. Generate RSA keys
    print("\n=== Generating RSA keys ===")
    run(client, f"mkdir -p {REMOTE_DIR}/keys")
    run(client, f"openssl genrsa -out {REMOTE_DIR}/keys/private.pem 2048 2>/dev/null", check=False)
    run(client, f"openssl rsa -in {REMOTE_DIR}/keys/private.pem -pubout -out {REMOTE_DIR}/keys/public.pem 2>/dev/null", check=False)

    # 7. Initialize database tables
    print("\n=== Creating database tables ===")
    run(client, f"cd {REMOTE_DIR} && venv/bin/python -c \"from app.database import Base, engine; from app.models import *; Base.metadata.create_all(bind=engine); print('Tables created')\"")

    # 8. Start service with pm2
    print("\n=== Starting service ===")
    run(client, "npm install -g pm2 2>/dev/null || true", check=False)
    run(client, f"pm2 delete mona-auth 2>/dev/null || true", check=False)
    run(client, f"cd {REMOTE_DIR} && pm2 start 'venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000' --name mona-auth")
    run(client, "pm2 save")

    # 9. Verify
    print("\n=== Verifying ===")
    run(client, "sleep 2 && curl -s http://127.0.0.1:8000/health")

    # 10. Print public key for client
    print("\n=== RSA Public Key (copy to src-tauri/src/license_pubkey.pem) ===")
    pub_key, _, _ = run(client, f"cat {REMOTE_DIR}/keys/public.pem")
    print(pub_key)

    # 11. Open firewall
    print("\n=== Opening firewall ===")
    run(client, "firewall-cmd --permanent --add-port=8000/tcp 2>/dev/null && firewall-cmd --reload 2>/dev/null || iptables -I INPUT -p tcp --dport 8000 -j ACCEPT 2>/dev/null || echo 'No firewall config needed'", check=False)

    print("\n=== DONE! ===")
    print(f"API: http://{HOST}:8000/health")
    print(f"Admin: http://{HOST}:8000/admin/")
    print("Next: Register an account via client, then set is_admin=1 in MySQL")

    client.close()

if __name__ == "__main__":
    main()
