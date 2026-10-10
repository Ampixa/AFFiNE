# Manual release for the Ampixa systemd installation

A merge updates source code. The existing installation runs a compiled application
from `/opt/affine/app`; pulling Git or restarting that directory does not build a
new release. Deployment is a maintainer action after the gates below pass.

The inherited upstream release workflows publish upstream images and target
upstream infrastructure. They are not an AWS deployment pipeline for this fork.
Do not dispatch them as a shortcut for this procedure.

## 1. Record the release and inspect the host

Choose one reviewed commit from `ampixa/selfhosted`. Record its full SHA, the
application version, Linux x86_64 target, toolchain versions, test results and
artifact checksum with the release. Build every component from that SHA. Do not
mix files from individual PR worktrees or an older downloaded native module.

Run `bash deploy/ampixa/release-preflight.sh` on the deployment host, or send the
script through an already authenticated SSH connection. It is read-only and
prints no environment-file contents. Its successful exit is **not** a readiness
verdict. Review service paths, available memory, active paging and free disk.

Keep the resulting machine inventory private. Back up the installed bundle,
PostgreSQL database, `/etc/affine`, service units, and the actual configured
storage/configuration paths, including the existing private key. Verify the
backup can be restored. External object storage needs its own recovery plan.
Do not assume a backup of `/opt/affine/app` includes uploaded documents.

## 2. Build on a separate Linux x86_64 builder

Use a disposable clean checkout with adequate RAM/disk, Docker, Node from
`.nvmrc`, Yarn from `packageManager`, and Rust from `rust-toolchain.toml`.
Install the compiler prerequisites for the repository's native build, including
Clang and the required development libraries. Never compile on the small
production VM. Do not supply production API keys or cloud publishing credentials
to the builder.

The build order follows `.github/workflows/build-images.yml`. The following is a
manual recipe to validate on the builder, not a previously built release:

```bash
# In a NEW disposable clone, after choosing the reviewed SHA and app version:
set -euo pipefail
: "${AFFINE_RELEASE_SHA:?Set the full reviewed Git SHA}"
: "${AFFINE_APP_VERSION:?Set the reviewed application compatibility version}"
git checkout --detach "$AFFINE_RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$AFFINE_RELEASE_SHA"
test -z "$(git status --porcelain)"
test "$(node --version)" = "v$(tr -d '\r\n' < .nvmrc)"
test "$(uname -m)" = x86_64
test "$(uname -s)" = Linux

export HUSKY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
export SENTRYCLI_SKIP_DOWNLOAD=1 YARN_ENABLE_SCRIPTS=true
export BUILD_TYPE=stable
corepack enable
./scripts/set-version.sh "$AFFINE_APP_VERSION"
yarn install --immutable --inline-builds
yarn affine @affine/web build
yarn affine @affine/admin build
yarn affine @affine/mobile build

export CC='clang -D_BSD_SOURCE'
export TARGET_CC="$CC"
yarn workspace @affine/server-native build --target x86_64-unknown-linux-gnu
mv packages/backend/native/server-native.node packages/backend/native/server-native.x64.node
yarn workspace @affine/server build
```

The version-setting script uses `jq` and changes package metadata intentionally.
Record this version overlay; do not commit generated version changes back to the
feature branch. The serving `/info` version is not sufficient to identify a fork
commit. Keep the existing compatible release version unless a version change has
been reviewed; source package defaults can differ from the installed version.

Before reducing the dependency tree, run the relevant repository tests, including
MCP search/Kanban, selected Page/file context, attachment downloads and storage
cleanup. Run the gateway tests with the same Node major as production:

```bash
node --test deploy/ampixa/claude-files/gateway.test.mjs
node --check deploy/ampixa/claude-files/provision.mjs
node deploy/ampixa/claude-files/memory-smoke.mjs
```

Keep test logs. Focused tests with mocked infrastructure do not replace a native
build or a staging integration run.

## 3. Package and test the complete application

After successful builds/tests, mirror the packaging steps in `build-images.yml`
and `.github/deployment/node/Dockerfile` in the disposable checkout:

```bash
yarn workspaces focus @affine/server --production
yarn workspace @affine/server prisma generate
mv node_modules packages/backend/server/node_modules

AFFINE_BUILD_TAG="ampixa-affine-prepared:${AFFINE_RELEASE_SHA:0:12}"
docker build --platform linux/amd64 -t "$AFFINE_BUILD_TAG" \
  -f .github/deployment/node/Dockerfile .

# Create a stopped container only to extract the prepared /app tree.
AFFINE_EXPORT_ID=$(docker create "$AFFINE_BUILD_TAG")
mkdir -p release/app
docker cp "$AFFINE_EXPORT_ID:/app/." release/app/
docker rm "$AFFINE_EXPORT_ID"
printf '%s\n' "$AFFINE_RELEASE_SHA" > release/SOURCE_COMMIT
printf '%s\n' "$AFFINE_APP_VERSION" > release/APP_VERSION
cp -a deploy/ampixa/claude-files release/claude-files
tar -czf "affine-${AFFINE_RELEASE_SHA:0:12}-linux-x64.tar.gz" -C release .
sha256sum "affine-${AFFINE_RELEASE_SHA:0:12}-linux-x64.tar.gz"
```

This builds locally on the builder and publishes nothing. Use a fresh `release`
directory. Confirm the exported tree contains backend `dist/main.js`, matching
`dist/server-native.x64.node`, web/admin/mobile static assets, runtime dependencies,
Prisma client/engines, schema, migrations and scripts. Preserve symlinks when
transferring. Retain source SHA, version overlay, checksum and test logs together.

Start this artifact in isolated staging with a disposable database/configuration,
not production credentials or storage. Check native loading, migration status,
login, a Page read/write, attachment download, and MCP operations. Exercise the
new bounded native storage read using an over-limit fixture. Its TypeScript
declaration alone cannot prove that the deployed native binary enforces the cap.

## 4. Maintainer rollout

1. Verify the artifact checksum and available space for **both** staged and old
   bundles, database backup and working space. Copy into a separate staging
   directory, never over the running app. The current systemd layout may use a
   real directory rather than a release symlink; inspect before switching it.
2. Review pending schema **and data** migrations against the installed database
   and test their restore plan in staging. The file-chat change adds no migration,
   but that does not establish that every older installation is schema-compatible.
   `scripts/self-host-predeploy.js` applies migrations and may generate a missing
   private key: it is not a read-only check. Run reviewed migrations under the
   `affine` service identity with its existing environment/home and Node/Yarn paths,
   only after backups and with writes quiesced as needed. Preserve the private key.
3. In the maintenance window stop AFFiNE, preserve the previous complete app,
   activate the staged app at the service's working directory and start AFFiNE.
   Deploy backend and native together. Keep PostgreSQL, Redis, uploads, existing
   config, credentials, LiteLLM, and unrelated services intact. Do not rerun the
   new-host bootstrap or use the old frontend-only deployment script.
4. Confirm `/info`, sign-in, document access, existing Auto chat and the browser
   asset loads before enabling optional features. Compare installed fingerprints
   with the prepared artifact and retain its source manifest on the host.

## 5. Enable features in stages

| Feature                       | Deployment / acceptance requirement                                                                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attachment downloads          | New frontend; download TXT and an unknown-extension fixture; verify an error is visible on a failed download.                                                                                                                                                                       |
| Storage cleanup recovery      | New frontend; use disposable files and confirm a failed deletion can be retried.                                                                                                                                                                                                    |
| MCP search                    | New backend improves error handling. Successful keyword search still requires the configured indexer; see [SEARCH.md](SEARCH.md). Do not add the optional 1 GiB search service to a host without headroom.                                                                          |
| Kanban tools                  | New backend with MCP writes enabled; create a disposable unfiltered, single-select board in the UI, then discover it with an existing read/write credential. Create a task and move it through MCP. Confirm the browser displays the change and read-only credentials cannot write. |
| Selected Pages                | New backend; follow [DOCUMENT-CHAT.md](DOCUMENT-CHAT.md), including permissions and unavailable-source failures.                                                                                                                                                                    |
| PDF, DOCX, TXT and image chat | New backend **and native**, plus gateway/profile opt-in in [claude-files/README.md](claude-files/README.md). Use `/opt/affine/node`, not system Node.                                                                                                                               |

For Claude file chat, first assess headroom under representative load, then
install/start the gateway, provision its separate profile, and finally opt in the
workspace. Existing Claude credentials are reused; no Gemini key or local
embedding/OCR model is required. Provisioning makes small paid provider requests.
Leave it disabled if probes, memory checks or real synthetic-file tests fail.
Test a PDF, a scanned PDF, a DOCX paragraph/table, image text, and follow-up reuse.
The gateway's hard memory cap is not proof the whole VM has sufficient capacity.

## 6. Rollback and sign-off

Record each gate as passed, failed or not run. A merged PR, local unit suite or
healthy landing page does not establish that file chat or Kanban works end to end.

For file-only failures, remove its workspace opt-in, disable its additional
profile, restart AFFiNE and stop the file gateway as described in its runbook.
Keep the existing chat route. For application rollback, restore the previous
complete frontend/backend/native/dependency set and compatible configuration.
If migrations changed data incompatibly, code rollback alone is insufficient:
use the tested database/storage restore plan and account for subsequent writes.
Do not delete uploaded files, reset credentials, or prune Docker volumes.
