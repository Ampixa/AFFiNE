#!/usr/bin/env bash
# Code-only rollback for a release that ran no database migrations.
set -Eeuo pipefail
umask 077
[[ $# = 1 && $1 =~ ^[a-f0-9]{40}$ ]] || { echo 'Usage: rollback-release.sh CURRENT_FULL_SHA'; exit 1; }
[[ $(id -u) = 0 ]] || { echo 'Run with sudo bash.'; exit 1; }
expected=$1
exec 9>/run/lock/affine-manual-release.lock
flock -n 9 || { echo 'Another AFFiNE release is running.'; exit 1; }
[[ $(cat /opt/affine/app/SOURCE_COMMIT) = "$expected" ]] || { echo 'Current app differs; inspect before rolling back.'; exit 1; }
backup=$(cat /opt/affine/LAST_RELEASE_BACKUP)
[[ $backup = /opt/affine/backups/deploy-* && ! -L $backup && -f "$backup/app/dist/main.js" ]] || { echo 'Previous complete app is unavailable.'; exit 1; }
[[ $(cat "$backup/DEPLOYED_COMMIT") = "$expected" ]] || { echo 'Backup does not belong to this deployment.'; exit 1; }
[[ ! -e "$backup/rolled-back-app" ]]
systemctl stop affine
restore_current() {
  code=$1
  trap - ERR INT TERM
  set +e
  systemctl stop affine
  if [[ -d "$backup/rolled-back-app" ]]; then
    if [[ -d /opt/affine/app ]]; then mv /opt/affine/app "$backup/app"; fi
    mv "$backup/rolled-back-app" /opt/affine/app
  fi
  systemctl start affine
  echo "Rollback failed; current release restoration attempted. Inspect $backup and the service logs."
  exit "$code"
}
trap 'restore_current $?' ERR
trap 'restore_current 130' INT
trap 'restore_current 143' TERM
mv /opt/affine/app "$backup/rolled-back-app"
mv "$backup/app" /opt/affine/app
systemctl start affine
healthy=0
for attempt in $(seq 1 45); do
  if systemctl is-active --quiet affine && curl -fsS --max-time 3 http://127.0.0.1:3010/info; then healthy=1; break; fi
  sleep 2
done
[[ $healthy = 1 ]]
trap - ERR INT TERM
printf '\nPrevious complete app restored. Database, uploaded data, gateways and configuration were not restored or changed.\n'
