#!/usr/bin/env bash
# Forced SSH command. Never expose a general-purpose root shell through this key.
set -Eeuo pipefail
umask 077
[[ $(id -u) = 0 && $# = 1 ]] || exit 2
[[ $1 =~ ^deploy\ ([a-f0-9]{40})\ ([a-f0-9]{64})$ ]] || { echo 'Invalid deployment command'; exit 2; }
sha=${BASH_REMATCH[1]}
checksum=${BASH_REMATCH[2]}
exec 8>/run/lock/affine-ci-receive.lock
flock -n 8 || { echo 'Another upload is active'; exit 1; }
# Authorize only the current merged production source, also after a queued build.
current=$(git ls-remote https://github.com/Ampixa/AFFiNE.git refs/heads/ampixa/selfhosted | cut -f1)
[[ $sha = "$current" ]] || { echo 'Superseded or unmerged release rejected'; exit 1; }
if [[ -f /opt/affine/app/SOURCE_COMMIT && $(cat /opt/affine/app/SOURCE_COMMIT) = "$sha" ]]; then
  echo "Already deployed $sha"; exit 0
fi
install -d -m 700 /opt/affine/releases
work=$(mktemp -d /opt/affine/releases/.ci-XXXXXX)
trap 'rm -rf -- "$work"' EXIT
# Bounded transfer protects the small production disk from unbounded stdin.
python3 -c '
import shutil, sys
with open(sys.argv[1], "wb") as f:
    count=0
    while chunk := sys.stdin.buffer.read(1024*1024):
        count += len(chunk)
        if count > 1024**3 or shutil.disk_usage(f.name).free < 512*1024**2:
            raise SystemExit("Upload size or disk reserve exceeded")
        f.write(chunk)
' "$work/archive.tar.gz"
[[ $(sha256sum "$work/archive.tar.gz" | cut -d ' ' -f1) = "$checksum" ]]
expanded=$(python3 /usr/local/lib/affine-ci/safe_archive.py "$work/archive.tar.gz")
free_kb=$(df -Pk /opt/affine | awk 'NR==2 {print $4}')
(( free_kb * 1024 > expanded + 536870912 )) || { echo 'Insufficient disk for extraction'; exit 1; }
mkdir "$work/release"
tar --no-same-owner --no-same-permissions -xzf "$work/archive.tar.gz" -C "$work/release"
[[ $(cat "$work/release/SOURCE_COMMIT") = "$sha" ]]
# Keep the reviewed host helper outside the uploaded application.
bash /usr/local/lib/affine-ci/deploy-release.sh "$work/release" "$sha"
echo "CI deployment completed: $sha"
