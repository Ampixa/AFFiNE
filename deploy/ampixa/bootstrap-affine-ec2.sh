#!/usr/bin/env bash
set -Eeuo pipefail

# Run manually on the new AFFiNE EC2 host as root, after reviewing:
#   ssh -i ~/.ssh/affine-test-ap-south-1 ubuntu@3.108.203.159 'sudo bash -s' \
#     < affine-ampixa/artifacts/bootstrap-affine-ec2.sh

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || die 'run this script through sudo as root'
id affine >/dev/null 2>&1 || die 'system user affine is missing'
[[ -x /opt/affine/node ]] || die 'the AFFiNE Node runtime is missing under /opt/affine'
[[ -f /opt/affine/app/dist/main.js ]] || die 'the AFFiNE server bundle is missing'
[[ -f /opt/affine/yarn-v1.22.22/bin/yarn.js ]] || die 'the bundled Yarn runtime is missing'
[[ -f /usr/lib/x86_64-linux-gnu/libjemalloc.so.2 ]] || die 'libjemalloc2 is not installed'
command -v curl >/dev/null 2>&1 || die 'curl is not installed'

for unit in postgresql redis-server nginx; do
  systemctl is-active --quiet "$unit" || die "$unit is not active"
done

if runuser -u postgres -- psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname = 'affine'" | grep -qx 1; then
  die 'PostgreSQL role affine already exists; refusing to replace credentials'
fi
if runuser -u postgres -- psql -Atqc "SELECT 1 FROM pg_database WHERE datname = 'affine'" | grep -qx 1; then
  die 'PostgreSQL database affine already exists; refusing to overwrite it'
fi
[[ ! -e /etc/affine/affine.env ]] || die '/etc/affine/affine.env already exists'
[[ ! -e /var/lib/affine/.affine/config/config.json ]] || die 'AFFiNE config already exists'
[[ ! -e /etc/systemd/system/affine.service ]] || die 'affine.service already exists'

DB_PASS="$(openssl rand -hex 32)"
install -d -o root -g root -m 0750 /etc/affine
install -d -o affine -g affine -m 0750 \
  /var/lib/affine/.affine/config /var/lib/affine/.affine/storage
install -d -o root -g root -m 0755 /opt/affine/bin
ln -sfn /opt/affine/node /opt/affine/bin/node
ln -sfn /opt/affine/yarn-v1.22.22/bin/yarn.js /opt/affine/bin/yarn

printf "CREATE ROLE affine WITH LOGIN PASSWORD '%s';\n" "$DB_PASS" \
  | runuser -u postgres -- psql -v ON_ERROR_STOP=1
runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE affine OWNER affine;'
runuser -u postgres -- psql -d affine -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'

umask 077
cat > /etc/affine/affine.env <<EOF
NODE_ENV=production
DEPLOYMENT_TYPE=selfhosted
DATABASE_URL=postgresql://affine:${DB_PASS}@127.0.0.1:5432/affine
REDIS_SERVER_HOST=127.0.0.1
LISTEN_ADDR=127.0.0.1
AFFINE_SERVER_HOST=localhost
AFFINE_SERVER_PORT=3010
EOF
unset DB_PASS

cat > /var/lib/affine/.affine/config/config.json <<'EOF'
{"server":{"name":"Ampixa AFFiNE"}}
EOF
chown affine:affine /var/lib/affine/.affine/config/config.json
chmod 0640 /var/lib/affine/.affine/config/config.json

set -a
# shellcheck disable=SC1091
. /etc/affine/affine.env
set +a
export HOME=/var/lib/affine
export USER=affine LOGNAME=affine
export PATH=/opt/affine/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
export NODE_OPTIONS=--max-old-space-size=512
runuser --preserve-environment --user=affine -- \
  /bin/bash -c 'cd /opt/affine/app && exec /opt/affine/node ./scripts/self-host-predeploy.js'

cat > /etc/systemd/system/affine.service <<'EOF'
[Unit]
Description=AFFiNE self-hosted server
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=affine
Group=affine
WorkingDirectory=/opt/affine/app
EnvironmentFile=/etc/affine/affine.env
Environment=HOME=/var/lib/affine
Environment=PATH=/opt/affine/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
Environment=NODE_OPTIONS=--max-old-space-size=512
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
Restart=on-failure
RestartSec=10
TimeoutStartSec=600
TimeoutStopSec=30
LimitNOFILE=65536
ExecStart=/opt/affine/node ./dist/main.js

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 /etc/systemd/system/affine.service

systemctl daemon-reload
systemctl enable --now affine

for attempt in $(seq 1 60); do
  if curl --silent --show-error --fail --output /dev/null \
    --max-time 3 http://127.0.0.1:3010/; then
    printf 'AFFiNE is responding on 127.0.0.1:3010\n'
    systemctl --no-pager --full status affine
    exit 0
  fi
  sleep 2
done

systemctl --no-pager --full status affine || true
journalctl -u affine -n 100 --no-pager
die 'AFFiNE did not become ready within 120 seconds'
