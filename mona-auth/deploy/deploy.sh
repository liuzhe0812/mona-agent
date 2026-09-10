#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if [[ "${BACKUP_CONFIRMED:-}" != "1" ]]; then
    echo "Refusing deployment: set BACKUP_CONFIRMED=1 after verifying a restorable database backup."
    exit 1
fi
if grep -q "mona.example.com" deploy/nginx.conf; then
    echo "Refusing deployment: replace the example Nginx domain and certificate paths first."
    exit 1
fi
if [[ ! -f .env || ! -x venv/bin/alembic || ! -x venv/bin/uvicorn ]]; then
    echo "Refusing deployment: .env or the production virtual environment is missing."
    exit 1
fi
if ! grep -qx "MONA_AUTH_ENVIRONMENT=production" .env; then
    echo "Refusing deployment: MONA_AUTH_ENVIRONMENT must be production."
    exit 1
fi
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "Refusing deployment: the release must come from a versioned Git checkout."
    exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
    echo "Refusing deployment: the release checkout contains uncommitted files."
    exit 1
fi

release_sha="$(git rev-parse HEAD)"
echo "Deploying Mona Auth release ${release_sha}"

venv/bin/alembic current
venv/bin/alembic upgrade head

sudo cp deploy/mona-auth.service /etc/systemd/system/mona-auth.service
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mona-auth
sudo ln -sfn /etc/nginx/sites-available/mona-auth /etc/nginx/sites-enabled/mona-auth
sudo nginx -t

sudo systemctl daemon-reload
sudo systemctl enable mona-auth
sudo systemctl restart mona-auth
sudo systemctl reload nginx

for _ in {1..20}; do
    if curl --fail --silent http://127.0.0.1:8901/ready >/dev/null; then
        echo "Mona Auth ${release_sha} is healthy."
        exit 0
    fi
    sleep 1
done

echo "Deployment failed: health check did not pass."
sudo systemctl status mona-auth --no-pager
exit 1
