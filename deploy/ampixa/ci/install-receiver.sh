#!/usr/bin/env bash
# One-time host setup. Supply only the dedicated CI PUBLIC key, never a private key.
set -Eeuo pipefail
[[ $(id -u) = 0 && $# = 1 && $1 = /* ]] || { echo 'Usage: sudo bash install-receiver.sh /absolute/ci-key.pub'; exit 2; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ssh-keygen -lf "$1"
read -r type material comment < "$1"
[[ $type = ssh-ed25519 && $material =~ ^[A-Za-z0-9+/=]+$ ]]
user=affine-ci
if ! id "$user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$user"
fi
home=$(getent passwd "$user" | cut -d: -f6)
chown root:root "$home"
chmod 755 "$home"
install -d -o root -g root -m 755 /usr/local/lib/affine-ci
install -o root -g root -m 755 "$here/receive.sh" /usr/local/sbin/affine-ci-receive
install -o root -g root -m 644 "$here/safe_archive.py" /usr/local/lib/affine-ci/safe_archive.py
install -o root -g root -m 755 "$here/deploy-release.sh" /usr/local/lib/affine-ci/deploy-release.sh
install -o root -g root -m 755 "$here/rollback-release.sh" /usr/local/lib/affine-ci/rollback-release.sh
install -d -o root -g root -m 755 "$home/.ssh"
auth="$home/.ssh/authorized_keys"
[[ ! -e $auth ]] || { echo 'Existing CI authorization requires manual review'; exit 1; }
printf 'restrict,command="sudo -n /usr/local/sbin/affine-ci-receive \\"$SSH_ORIGINAL_COMMAND\\"" %s %s affine-production-ci\n' "$type" "$material" > "$auth"
chown root:root "$auth"
chmod 644 "$auth"
sudoers=$(mktemp)
trap 'rm -f "$sudoers"' EXIT
echo 'affine-ci ALL=(root) NOPASSWD: /usr/local/sbin/affine-ci-receive' > "$sudoers"
visudo -cf "$sudoers"
install -o root -g root -m 440 "$sudoers" /etc/sudoers.d/affine-ci
sshd -t
echo 'Installed restricted deployment endpoint. No application or provider configuration changed.'
