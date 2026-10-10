#!/usr/bin/env bash
set -euo pipefail
trap 'printf "Deployment failed at line %s\n" "$LINENO" >&2' ERR

task_dist=/Users/cdjk/affine-ampixa/source/packages/frontend/apps/web/dist
task_host=ubuntu@3.108.203.159
task_key=/Users/cdjk/.ssh/affine-test-ap-south-1
task_release="invite-expiry-$(date -u +%Y%m%dT%H%M%SZ)"
task_ssh=(-i "$task_key" -o BatchMode=yes -o ConnectTimeout=10)

for task_file in selfhost.html index.html assets-manifest.json; do
  test -f "$task_dist/$task_file"
done
task_entry=$(node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const entry = manifest.js.find(path => /^js\/index\.[a-f0-9]+\.js$/.test(path));
  if (!entry) throw new Error("Built index asset is missing");
  process.stdout.write(entry);
' "$task_dist/assets-manifest.json")
test -f "$task_dist/$task_entry"

ssh "${task_ssh[@]}" "$task_host" bash -s -- "$task_release" <<'REMOTE'
set -euo pipefail
release=$1
[[ $release =~ ^invite-expiry-[0-9]{8}T[0-9]{6}Z$ ]]
test -f /opt/affine/app/static/selfhost.html
test -d /opt/affine/app/static/admin
test -d /opt/affine/app/static/mobile
mkdir -p "/tmp/affine-web-$release"
REMOTE

rsync -a --no-owner --no-group \
  -e "ssh -i $task_key -o BatchMode=yes -o ConnectTimeout=10" \
  "$task_dist/" "$task_host:/tmp/affine-web-$task_release/"

ssh "${task_ssh[@]}" "$task_host" bash -s -- "$task_release" <<'REMOTE'
set -euo pipefail
release=$1
[[ $release =~ ^invite-expiry-[0-9]{8}T[0-9]{6}Z$ ]]
stage="/tmp/affine-web-$release"
destination=/opt/affine/app/static
backup="/opt/affine/backups/$release"
test -f "$stage/selfhost.html"
test -f "$stage/assets-manifest.json"
sudo mkdir -p "$backup"
for file in selfhost.html index.html assets-manifest.json; do
  sudo cp -a "$destination/$file" "$backup/$file"
done
# Upload assets first, retaining previous hashes and the admin/mobile apps.
sudo rsync -a --no-owner --no-group \
  --exclude=/selfhost.html --exclude=/index.html \
  --exclude=/assets-manifest.json --exclude=/admin/ --exclude=/mobile/ \
  "$stage/" "$destination/"
# Each HTML/manifest replacement is atomic; publish selfhost.html last.
for file in assets-manifest.json index.html selfhost.html; do
  sudo install -m 644 "$stage/$file" "$destination/.$file.$release"
  sudo mv "$destination/.$file.$release" "$destination/$file"
done
rm -rf -- "$stage"
printf 'Published frontend; rollback HTML and manifest are in %s\n' "$backup"
REMOTE

task_page=$(mktemp)
trap 'rm -f "$task_page"' EXIT
curl --fail --silent --show-error https://affine.ampixa.com/ -o "$task_page"
if ! grep -Fq "$task_entry" "$task_page"; then
  printf 'The live page does not reference the expected asset: %s\n' "$task_entry" >&2
  exit 1
fi
curl --fail --silent --show-error --head "https://affine.ampixa.com/$task_entry" >/dev/null
printf 'Verified live frontend asset: %s\n' "$task_entry"
