#!/usr/bin/env bash
# Run only in a disposable Linux x64 checkout; this reduces its dependency tree.
set -Eeuo pipefail
trap 'code=$?; printf "Build failed at line %s (exit %s): %s\n" "$LINENO" "$code" "$BASH_COMMAND" >&2; exit "$code"' ERR
root=$(git rev-parse --show-toplevel)
cd "$root"
[[ $(uname -sm) = 'Linux x86_64' ]]
test -z "$(git status --porcelain)"
sha=$(git rev-parse HEAD)
out="${AFFINE_RELEASE_OUTPUT:?Set an absolute output directory outside the checkout}"
[[ $out = /* && $out != "$root"/* && ! -e $out ]]
version="${AFFINE_RELEASE_VERSION:-0.27.4}"
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ $(node --version) = "v$(tr -d '\r\n' < .nvmrc)" ]]
mkdir -p "$out"
exec > >(tee "$out/build.log") 2>&1
export HUSKY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
export SENTRYCLI_SKIP_DOWNLOAD=1 YARN_ENABLE_SCRIPTS=true BUILD_TYPE=stable
export CARGO_BUILD_JOBS=4 RAYON_NUM_THREADS=2 NODE_OPTIONS=--max-old-space-size=6144
export CC='clang -D_BSD_SOURCE' TARGET_CC='clang -D_BSD_SOURCE'
corepack enable
yarn install --immutable --inline-builds
# One validation path for the self-hosted web release, before version overlays.
yarn lint:ox
yarn lint:format
yarn typecheck
./scripts/set-version.sh "$version"
git diff --binary > "$out/version-overlay.patch"
yarn workspace @affine/server-native build --target x86_64-unknown-linux-gnu
mv packages/backend/native/server-native.node packages/backend/native/server-native.x64.node
for package in @affine/web @affine/admin @affine/mobile; do yarn affine "$package" build; done
# Packaging a single platform avoids the generated loader selecting a missing file.
cat > packages/backend/native/index.js <<'JS'
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('This AFFiNE release requires Linux x64');
}
module.exports = require('./server-native.x64.node');
JS
git diff -- packages/backend/native/index.js > "$out/linux-x64-loader.patch"
yarn workspace @affine/server build
if grep -Eq 'ERROR in |compiled with [1-9][0-9]* errors' "$out/build.log"; then
  echo 'Bundler reported errors'; exit 1
fi
yarn vitest run --maxWorkers=2 \
  packages/frontend/core/src/blocksuite/ai/messages/error.spec.ts \
  packages/frontend/core/src/blocksuite/ai/components/ai-tools/doc-write.spec.ts \
  packages/frontend/core/src/blocksuite/ai/runtime/request/copilot-client.spec.ts
node deploy/ampixa/ci/verify-native.cjs packages/backend/server/dist/server-native.x64.node
node --test deploy/ampixa/claude-files/gateway.test.mjs deploy/ampixa/enable-search.test.mjs
node deploy/ampixa/claude-files/memory-smoke.mjs
(
  cd packages/backend/server
  NODE_OPTIONS="--import=$root/tools/cli/register.js" yarn test \
    src/__tests__/copilot/local-document-search.spec.ts \
    src/__tests__/copilot/document-editing.spec.ts \
    src/__tests__/copilot/local-search-postgres.spec.ts \
    src/__tests__/copilot/mcp-search.spec.ts \
    src/__tests__/copilot/capability-runtime.spec.ts \
    src/__tests__/copilot/native-errors.spec.ts \
    src/__tests__/copilot/runtime-boundaries.spec.ts \
    src/__tests__/copilot/mcp-kanban.spec.ts \
    src/__tests__/copilot/selected-document-context.spec.ts \
    src/__tests__/copilot/selected-file-context.spec.ts
)
# Do not silently skip the disposable PostgreSQL integration test.
: "${LOCAL_SEARCH_TEST_DATABASE_URL:?Disposable PostgreSQL is required}"
git diff --exit-code -- Cargo.lock yarn.lock
export YARN_ENABLE_SCRIPTS=false
yarn workspaces focus @affine/server --production
yarn workspace @affine/server prisma generate
# AVA leaves a workspace-local cache; remove only that cache and reject real
# unhoisted dependencies instead of silently nesting or overwriting them.
python3 deploy/ampixa/ci/prepare_dependencies.py "$root"
release="$out/release"
mkdir "$release"
cp -a packages/backend/server "$release/app"
cp -a packages/frontend/apps/web/dist "$release/app/static"
cp -a packages/frontend/admin/dist "$release/app/static/admin"
cp -a packages/frontend/apps/mobile/dist "$release/app/static/mobile"
# Despite the inherited name, this is a Node packaging script, not Docker.
AFFINE_DOCKER_CLEAN=1 TARGETARCH=amd64 APP_ROOT="$release/app" \
  node packages/backend/server/scripts/docker-clean.mjs
printf '%s\n' "$sha" > "$release/SOURCE_COMMIT"
printf '%s\n' "$version" > "$release/APP_VERSION"
cp deploy/ampixa/ci/deploy-release.sh "$release/deploy.sh"
cp deploy/ampixa/ci/rollback-release.sh "$release/rollback.sh"
cp deploy/ampixa/ci/verify-native.cjs "$release/"
cp -a deploy/ampixa/claude-files "$release/"
cp "$out/"*.patch "$release/"
cp LICENSE "$release/"
python3 - "$release" "$sha" "$version" <<'PY'
import datetime, hashlib, json, pathlib, re, subprocess, sys
r=pathlib.Path(sys.argv[1])
names=sorted(n for p in pathlib.Path('packages/backend/server/src/data/migrations').glob('*.ts')
             for n in re.findall(r'export class (\w+)',p.read_text()))
(r/'DATA_MIGRATION_NAMES.json').write_text(json.dumps(names)+'\n')
m={'source_repository':'https://github.com/Ampixa/AFFiNE','source_commit':sys.argv[2],
   'app_version':sys.argv[3],'target':'linux-x86_64-glibc',
   'node':subprocess.check_output(['node','--version'],text=True).strip(),
   'built_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
   'validation':'Build, native bounded reads, gateway and focused backend tests; browser acceptance is manual.'}
(r/'RELEASE.json').write_text(json.dumps(m,indent=2)+'\n')
(r/'BUILD_VALIDATED').write_text(m['validation']+'\n')
PY
node "$release/verify-native.cjs" "$release/app/dist/server-native.x64.node"
for folder in static static/admin static/mobile; do
  test -f "$release/app/$folder/index.html"
  test -f "$release/app/$folder/selfhost.html"
done
if find "$release" \( -name .env -o -name private.key -o -name '*.pem' \) | grep -q .; then
  echo 'Unexpected runtime secrets in release'; exit 1
fi
(cd "$release"; find . -type f ! -name FILES.sha256 -print0 | sort -z | xargs -0 sha256sum > FILES.sha256)
archive="affine-${sha:0:12}-linux-x64.tar.gz"
tar --hard-dereference --owner=0 --group=0 -czf "$out/$archive" -C "$release" .
(cd "$out"; sha256sum "$archive" > "$archive.sha256"; sha256sum -c "$archive.sha256")
python3 deploy/ampixa/ci/safe_archive.py "$out/$archive"
echo "Packaged $sha; no production deployment performed."
