#!/bin/bash
set -e

echo "Installing mona-auth service..."
sudo cp deploy/mona-auth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mona-auth
sudo systemctl restart mona-auth

echo "Installing nginx config..."
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mona-auth
sudo ln -sf /etc/nginx/sites-available/mona-auth /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo "Deploying portal..."
sudo mkdir -p /var/www/mona-portal
sudo cp deploy/portal/index.html /var/www/mona-portal/index.html

echo "Done! Auth Service is running on https://mona.example.com"
