#!/bin/bash
# Amazon Linux 2023, run as root after /etc/emailautomation.env exists.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/ec2/setup.sh"
  exit 1
fi

if [[ ! -f /etc/emailautomation.env ]]; then
  echo "Create /etc/emailautomation.env first. Copy the keys from .env.example and fill them from Render."
  exit 1
fi

dnf install -y git nginx tar gzip
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v22\.'; then
  curl -fsSL https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.xz -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi

mkdir -p /opt
if [[ ! -d /opt/emailautomation-backend/.git ]]; then
  git clone https://github.com/ahmeddabbasi/emailautomation-backend.git /opt/emailautomation-backend
fi
cd /opt/emailautomation-backend
git pull --ff-only origin main
npm ci
npm run build

install -m 644 deploy/ec2/emailautomation.service /etc/systemd/system/emailautomation.service
install -m 644 deploy/ec2/nginx.conf /etc/nginx/conf.d/emailautomation.conf
rm -f /etc/nginx/conf.d/default.conf
install -m 755 deploy/ec2/cron-dispatch.sh /usr/local/bin/emailautomation-dispatch
echo "*/15 * * * * root /usr/local/bin/emailautomation-dispatch >> /var/log/emailautomation-dispatch.log 2>&1" > /etc/cron.d/emailautomation
chmod 644 /etc/cron.d/emailautomation

systemctl daemon-reload
systemctl enable --now emailautomation
systemctl enable --now nginx
nginx -t
systemctl reload nginx

echo "API is on port 80. Check: curl -fsS http://127.0.0.1/api/health/live"
