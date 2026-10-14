#!/usr/bin/env bash
# Upgrade the existing systemd installation with a verified, fully built release.
# No builds, migrations, provider provisioning, or credential changes occur here.
set -Eeuo pipefail
umask 077
fail() { echo "ERROR: $*" >&2; exit 1; }
[[ $# = 2 || ($# = 3 && $3 = --check) ]] || fail 'Usage: deploy-release.sh RELEASE_DIR FULL_SHA [--check]'
[[ $(id -u) = 0 ]] || fail 'Run with sudo bash.'
release=$(cd -- "$1" && pwd -P)
expected=$2
[[ $expected =~ ^[a-f0-9]{40}$ ]] || fail 'Use the full reviewed merge SHA.'
[[ $(cat "$release/SOURCE_COMMIT") = "$expected" ]] || fail 'Source SHA mismatch.'
[[ -f "$release/BUILD_VALIDATED" && -f "$release/FILES.sha256" ]] || fail 'Release is not validated.'
[[ -d "$release/app" && -f "$release/app/dist/main.js" ]] || fail 'Complete app missing.'
[[ ! -L /opt/affine/app && -f /opt/affine/app/dist/main.js ]] || fail 'Expected an existing app directory.'
[[ -f /var/lib/affine/.affine/config/private.key ]] || fail 'Existing private key missing; inspect the host.'
[[ $(uname -sm) = 'Linux x86_64' ]] || fail 'This release requires Linux x64.'
[[ $(systemctl show affine -p WorkingDirectory --value) = /opt/affine/app ]] || fail 'Unexpected service directory.'
[[ $(systemctl show affine -p User --value) = affine ]] || fail 'Unexpected service user.'
systemctl is-active --quiet affine || fail 'The existing service must be healthy before an upgrade.'
exec 9>/run/lock/affine-manual-release.lock
flock -n 9 || fail 'Another AFFiNE release is running.'
cd "$release"
sha256sum --quiet -c FILES.sha256
runtime=$(/opt/affine/node --version)
python3 - "$release" "$expected" "$runtime" <<'PY'
import json,pathlib,sys
r=pathlib.Path(sys.argv[1]); m=json.loads((r/'RELEASE.json').read_text())
assert m['source_commit']==sys.argv[2], 'Release metadata SHA mismatch'
assert m['node']==sys.argv[3], 'Node runtime differs from the validated builder'
assert m['target']=='linux-x86_64-glibc', 'Unexpected build target'
assert m['app_version']==(r/'APP_VERSION').read_text().strip(), 'App version mismatch'
PY
/opt/affine/node "$release/verify-native.cjs" "$release/app/dist/server-native.x64.node"
check_dir=$(mktemp -d)
trap 'rm -rf -- "$check_dir"' EXIT
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d affine -Atc \
  'SELECT json_agg(t) FROM (SELECT migration_name,checksum,finished_at IS NOT NULL AS finished FROM _prisma_migrations) t;' > "$check_dir/schema.json"
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d affine -Atc \
  'SELECT json_agg(t) FROM (SELECT name,finished_at IS NOT NULL AS finished FROM _data_migrations) t;' > "$check_dir/data.json"
python3 - "$release" "$check_dir" <<'PY'
import hashlib,json,pathlib,sys
r,c=map(pathlib.Path,sys.argv[1:]); rows=json.loads((c/'schema.json').read_text())
want={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (r/'app/migrations').glob('*/migration.sql')}
got={x['migration_name']:x['checksum'] for x in rows if x['finished']}
assert want and want==got and len(rows)==len(got), 'Schema migration mismatch: requires a separately reviewed migration plan'
expected=set(json.loads((r/'DATA_MIGRATION_NAMES.json').read_text())); data=json.loads((c/'data.json').read_text())
assert {x['name'] for x in data if x['finished']}==expected and all(x['finished'] for x in data), 'Data migration mismatch: inspect before upgrading'
print('PASS: all release migrations are already applied; no migrations will run.')
PY
app_kb=$(du -sk "$release/app" | awk '{print $1}')
state_kb=$(du -sk /etc/affine /var/lib/affine/.affine | awk '{n+=$1} END {print n}')
db_bytes=$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d affine -Atc 'SELECT pg_database_size(current_database());')
[[ $db_bytes =~ ^[0-9]+$ ]] || fail 'Could not size database backup.'
free_kb=$(df -Pk /opt/affine | awk 'NR==2 {print $4}')
required_kb=$((app_kb + state_kb + db_bytes / 1024 + 524288))
(( free_kb > required_kb )) || fail 'Insufficient disk for app copy, state/database backup and 512 MiB reserve.'
curl -fsS --max-time 10 http://127.0.0.1:3010/info > "$check_dir/old-info.json"
python3 - "$release/APP_VERSION" "$check_dir/old-info.json" <<'PY'
import json,pathlib,sys
assert json.load(open(sys.argv[2]))['compatibility']==pathlib.Path(sys.argv[1]).read_text().strip(), 'Compatibility version change requires separate review'
PY
if [[ ${3:-} = --check ]]; then
  echo "PASS: release $expected and current host passed preflight. No services or configuration changed."
  exit 0
fi
backup="/opt/affine/backups/deploy-$(date -u +%Y%m%dT%H%M%SZ)-${expected:0:12}"
[[ ! -e "$backup" ]] || fail 'Backup destination already exists.'
install -d -m 700 "$backup"
next_app=$(mktemp -d /opt/affine/.next-release-XXXXXX)
stopped=0
recover() {
  code=$1
  trap - ERR INT TERM
  set +e
  if [[ -d "$backup/app" ]]; then
    systemctl stop affine
    if [[ -d /opt/affine/app ]]; then mv /opt/affine/app "$backup/failed-app"; fi
    mv "$backup/app" /opt/affine/app
  fi
  if [[ $stopped = 1 ]]; then systemctl start affine; fi
  echo "Upgrade failed (exit $code). Previous app restoration attempted. Inspect affine logs and $backup."
  echo 'No automatic database restore or gateway/configuration change was performed.'
  exit "$code"
}
trap 'recover $?' ERR
trap 'recover 130' INT
trap 'recover 143' TERM
# Prepare permissions before downtime. Leave the verified release immutable.
cp -a "$release/app/." "$next_app/"
cp "$release/SOURCE_COMMIT" "$release/RELEASE.json" "$next_app/"
chown -R affine:affine "$next_app"
chmod -R a+rX "$next_app"
echo 'Stopping only AFFiNE for a coordinated backup and application switch.'
stopped=1
systemctl stop affine
sudo -u postgres pg_dump --format=custom --compress=1 --dbname=affine > "$backup/affine.pgdump"
paths=(etc/affine var/lib/affine/.affine)
for path in /etc/systemd/system/affine.service /etc/systemd/system/affine.service.d /etc/systemd/system/affine-haiku-gateway.service /etc/systemd/system/affine-haiku-gateway.service.d /etc/systemd/system/affine-claude-files.service /etc/systemd/system/affine-claude-files.service.d; do
  [[ ! -e "$path" ]] || paths+=("${path#/}")
done
tar -czf "$backup/config-storage.tar.gz" -C / "${paths[@]}"
gzip -t "$backup/config-storage.tar.gz"
sudo -u postgres pg_restore --file=/dev/null < "$backup/affine.pgdump"
(cd "$backup" && sha256sum affine.pgdump config-storage.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS)
mv /opt/affine/app "$backup/app"
mv "$next_app" /opt/affine/app
systemctl start affine
healthy=0
for attempt in $(seq 1 45); do
  if systemctl is-active --quiet affine && curl -fsS --max-time 3 http://127.0.0.1:3010/info > "$backup/new-info.json"; then healthy=1; break; fi
  sleep 2
done
[[ $healthy = 1 ]]
python3 - "$release/APP_VERSION" "$backup/new-info.json" <<'PY'
import json,pathlib,sys
assert json.load(open(sys.argv[2]))['compatibility']==pathlib.Path(sys.argv[1]).read_text().strip()
PY
curl -fsS --max-time 15 https://affine.ampixa.com/info
printf '\n'
printf '%s\n' "$backup" > /opt/affine/LAST_RELEASE_BACKUP
printf '%s\n' "$expected" > "$backup/DEPLOYED_COMMIT"
trap - ERR INT TERM
echo "Deployed $expected. Previous app and backups: $backup"
echo 'Existing Claude file chat, keys, service drop-ins, uploads and other services were retained.'
echo 'Do not rerun file-chat provisioning. Reload the browser and perform the release acceptance checks.'
