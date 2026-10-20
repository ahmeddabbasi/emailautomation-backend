#!/bin/bash
set -a
source /etc/emailautomation.env
set +a
export BACKEND_URL=http://127.0.0.1:3000
exec /usr/local/bin/node /opt/emailautomation-backend/scripts/cron-tick.mjs
