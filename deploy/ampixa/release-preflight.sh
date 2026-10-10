#!/usr/bin/env bash
# Read-only inventory for the existing systemd installation. Never prints env files.
set -euo pipefail

printf 'Checked at: '
date -u '+%Y-%m-%dT%H:%M:%SZ'
uname -sm

printf '\nAFFiNE runtime (expected Node 22):\n'
if [[ -x /opt/affine/node ]]; then
  /opt/affine/node -e '
    console.log(process.version);
    console.log(Number(process.versions.node.split(".")[0]) === 22
      ? "Runtime major matches the repository"
      : "BLOCKER: use the Node version in .nvmrc before rollout");
  '
else
  printf 'BLOCKER: /opt/affine/node is missing\n'
fi
if [[ -x /usr/bin/node ]]; then
  printf 'System Node (not used by the file gateway): '
  /usr/bin/node --version
fi

printf '\nService state and executable paths (no environment values):\n'
for unit in affine affine-haiku-gateway affine-claude-files; do
  systemctl show "$unit" --no-pager \
    -p Id -p LoadState -p ActiveState -p SubState -p ActiveEnterTimestamp \
    -p User -p Group -p WorkingDirectory -p ExecStart || true
done

printf '\nMemory and disk; review active paging, not swap usage alone:\n'
free -h
df -h /opt/affine
vmstat 1 3
du -sh /opt/affine/app 2>/dev/null || true

printf '\nInstalled bundle fingerprints (not a source-commit attestation):\n'
for file in /opt/affine/app/dist/main.js /opt/affine/app/dist/server-native.x64.node; do
  if [[ -r "$file" ]]; then
    sha256sum "$file"
  else
    printf 'Cannot read: %s\n' "$file"
  fi
done

printf '\nLocal server info:\n'
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3010/info || true
printf '\n\npgvector (requires existing non-interactive sudo access):\n'
sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d affine -c \
  "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';" || \
  printf 'Unavailable to this caller; run the read-only query as the database administrator.\n'

printf '\nInventory only: exit status is not a deployment approval. No services or data changed.\n'
