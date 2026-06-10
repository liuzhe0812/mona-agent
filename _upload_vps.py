import paramiko
import json
import os
from datetime import datetime, timezone

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)
sftp = ssh.open_sftp()

# Step 5: Upload files
print("Uploading NSIS installer as Mona-latest.exe...")
nsis_path = r"src-tauri\target\release\bundle\nsis\Mona_1.0.1_x64-setup.exe"
nsis_size = os.path.getsize(nsis_path)
print(f"  NSIS size: {nsis_size / 1_048_576:.0f} MB")
sftp.put(nsis_path, "/var/www/mona/releases/Mona-latest.exe")
print("  Done!")

print("Uploading update package mona-1.0.1.tar.gz...")
update_path = r"dist\mona-1.0.1.tar.gz"
update_size = os.path.getsize(update_path)
print(f"  Update size: {update_size / 1_048_576:.0f} MB")
sftp.put(update_path, "/var/www/mona/releases/mona-1.0.1.tar.gz")
print("  Done!")

# Step 6: Update manifest
print("Updating manifest...")
manifest = {
    "version": "1.0.1",
    "notes": "Mona 1.0.1 首个正式发布版本",
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "url": "https://mona.lzfun.vip/releases/mona-1.0.1.tar.gz",
    "sha256": "3c0e5c4f4919d838e4ead5b9025749af91c83c8b8260cca0fd7c2ee0fb9c9723",
    "size": update_size,
}

with sftp.open("/var/www/mona/updates/update.json", "w") as f:
    f.write(json.dumps(manifest, indent=2))
print("  Manifest updated!")

sftp.close()

# Verify
print("\nVerifying...")
stdin, stdout, stderr = ssh.exec_command("cat /var/www/mona/updates/update.json")
print(stdout.read().decode().strip())

stdin, stdout, stderr = ssh.exec_command("ls -lh /var/www/mona/releases/")
print(stdout.read().decode().strip())

ssh.close()
print("\nAll done!")
