#!/bin/bash
set -e

echo "=== Mona Auth Service Setup ==="

echo "[1/5] Creating virtual environment..."
python3 -m venv venv
source venv/bin/activate

echo "[2/5] Installing dependencies..."
pip install -e ".[dev]"

echo "[3/5] Generating RSA keys..."
python scripts/generate_keys.py

echo "[4/5] Copying .env (if not exists)..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "  Created .env from .env.example — please edit it with your settings!"
else
    echo "  .env already exists, skipping."
fi

echo "[5/5] Creating database tables..."
python scripts/init_db.py

echo ""
echo "=== Setup complete! ==="
echo "Next steps:"
echo "  1. Edit .env with your MariaDB credentials, Stripe keys, etc."
echo "  2. Run: source venv/bin/activate && uvicorn app.main:app --host 127.0.0.1 --port 8901"
echo "  3. Or deploy with: bash deploy/deploy.sh"
