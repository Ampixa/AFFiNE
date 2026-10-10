# Hosted document embeddings

Intelligence can answer plain chat through Claude Haiku while failing when a
document is attached. Chat generation and document embeddings use different
routes. `embedding_route_unavailable` means the workspace has no usable embedding
route; upgrading pgvector alone does not supply one.

Use **Gemini `gemini-embedding-001` for embeddings**, keeping the existing Haiku
gateway for chat. This fork's embedding contract stores **1,024-dimensional**
vectors. Its native Gemini adapter supports this model and dimensionality.
Self-hosted background indexing requires a **server-stored workspace BYOK
profile**; a global managed-provider profile or a browser-local key is not a
substitute. The helper creates an embedding-only profile, so Gemini is not a
candidate for chat or tool-calling routes.

## What runs on a small VM

There is no local embedding model, GPU, new container, Python environment or
second gateway. Gemini performs model inference; AFFiNE still parses documents,
queues work and stores/searches vectors in PostgreSQL. A two-core VM is a
reasonable starting point for a small workspace, **not a measured capacity
guarantee**. Large PDFs and simultaneous indexing can still exhaust RAM or CPU.
Deploy a prepared release; do not compile the monorepo on this VM.

Start with one small text document. Keep the existing Node memory limit and
worker behavior until measurements justify a change. The native embedding
worker processes queue items sequentially, with provider requests batched within
an item; do not launch extra runtimes to accelerate a backlog.

## Prerequisites and data handling

- PostgreSQL with **the installed `vector` extension >= 0.8.0** in the AFFiNE
  database, not just a newer OS package. An already upgraded 0.8.7 installation
  needs no further database upgrade for this setup.
- The deployed Ampixa backend exposing `BackendRuntime`, server BYOK and
  `index.embedding`, with its existing service environment and private key.
- Working Intelligence/server BYOK, an embedding-enabled workspace, and its
  active owner's user ID. The helper does not enable a workspace that opted out.
- A Gemini API key for a billing-enabled project with access to the embedding
  model. Obtain it in [AI Studio](https://aistudio.google.com/apikey), apply the
  appropriate API restrictions and review quota/budget alerts.

Document text and search queries are sent to Google for embedding; Claude
credits do not cover this separate API. Use the appropriate paid service terms
for private workspace data. The [official pricing/data-use page](https://ai.google.dev/gemini-api/docs/pricing)
describes the difference between free and paid tiers. The dry run sends only two
fixed synthetic strings. **Applying the profile can immediately start indexing
existing eligible workspace content.**

The API key enters through stdin and is encrypted by AFFiNE's native BYOK
credential storage. Never put it in a command argument, Git, config JSON, issue
or chat. Keep the existing AFFiNE private key: replacing it can make saved BYOK
credentials unreadable.

## Database upgrade, only when needed

Check without changing anything:

```sh
sudo -u postgres psql -d affine -c \
  "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

If below 0.8.0, take a database backup first. Use the
[official PostgreSQL Ubuntu repository instructions](https://www.postgresql.org/download/linux/ubuntu/)
if the Ubuntu package candidate is too old. Inspect `apt-cache policy` and
simulate installation of `postgresql-<installed-major>-pgvector` before applying
it; repository changes may also offer PostgreSQL packages. Do not upgrade the
PostgreSQL major version as part of this fix. Follow the
[pgvector upgrade instructions](https://github.com/pgvector/pgvector#upgrading),
including the database extension update:

```sh
sudo -u postgres psql -v ON_ERROR_STOP=1 -d affine \
  -c 'ALTER EXTENSION vector UPDATE;'
```

Verify the installed extension version again. Schedule any service restart
required by the package update separately. This PR does not install packages,
re-run the initial EC2 bootstrap, or modify PostgreSQL settings.

## Provision one workspace

These commands target the existing systemd EC2 layout used by
`bootstrap-affine-ec2.sh`. Review the PR, deploy/copy `enable-embeddings.mjs` to
`/opt/affine/ops/enable-embeddings.mjs` (root-owned, readable by `affine`), then
use a maintenance window. No backend build is needed when the installed native
runtime already exposes the required APIs. Do not re-run `provision-haiku.mjs`:
that older helper expects a Haiku-only workspace and refuses additional profiles.

From the reviewed repository checkout on the host:

```sh
sudo install -d -o root -g root -m 0755 /opt/affine/ops
sudo install -o root -g root -m 0644 deploy/ampixa/enable-embeddings.mjs \
  /opt/affine/ops/enable-embeddings.mjs
```

Identify the intended workspace and owner, without selecting any credentials:

```sh
sudo -u postgres psql -d affine -c "
SELECT w.id AS workspace_id, w.name, m.user_id AS owner_id,
       w.enable_ai, w.enable_doc_embedding
FROM workspaces w
JOIN workspace_members m ON m.workspace_id = w.id
JOIN users u ON u.id = m.user_id
WHERE m.role = 'owner' AND m.state = 'active' AND NOT u.disabled;"
```

In a root Bash shell (`sudo bash`), run the following. Environment loading
assumes the root-owned shell-compatible environment file from the bootstrap;
do not print its contents. The Gemini key is prompted privately. The helper
requires `psql` and Node 22, both already part of that deployment.

```bash
set -Eeuo pipefail
set +x
set -a
. /etc/affine/affine.env
set +a
export HOME=/var/lib/affine
export PATH=/opt/affine/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export NODE_OPTIONS=--max-old-space-size=512

read -rp 'Workspace ID: ' AFFINE_EMBED_WORKSPACE </dev/tty
read -rp 'Active owner user ID: ' AFFINE_EMBED_OWNER </dev/tty
read -rsp 'Gemini API key: ' AFFINE_EMBED_KEY </dev/tty
printf '\n'

run_embedding_setup() {
  printf '%s' "$AFFINE_EMBED_KEY" |
    runuser --preserve-environment --user=affine -- \
      /opt/affine/node /opt/affine/ops/enable-embeddings.mjs \
      --workspace "$AFFINE_EMBED_WORKSPACE" --owner "$AFFINE_EMBED_OWNER" "$@"
}

# Read-only database/config checks plus two synthetic API embeddings.
# No native runtime, workers, config or profile writes in this dry run.
run_embedding_setup

# Back up before applying; this dump contains private data and credentials.
install -d -m 0700 /var/backups/affine
umask 077
PGDATABASE="$DATABASE_URL" pg_dump -Fc \
  > "/var/backups/affine/before-embeddings-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Do not run a second runtime beside the live application.
systemctl is-active --quiet affine.service
trap 'unset AFFINE_EMBED_KEY; systemctl start affine.service' EXIT
systemctl stop affine.service
if run_embedding_setup --apply; then
  AFFINE_EMBED_RESULT=0
else
  AFFINE_EMBED_RESULT=$?
fi
unset AFFINE_EMBED_KEY
systemctl start affine.service
trap - EXIT
systemctl is-active affine.service
printf 'Embedding setup exit status: %s\n' "$AFFINE_EMBED_RESULT"
exit
```

The helper preserves existing config, allows Gemini alongside existing providers,
and saves a private `config.json.before-embeddings-*` backup if config changes.
It creates only the named workspace profile, probes its stored key, checks the
server embedding route and stops its runtime before the service is restarted.
Runtime startup may run existing native migrations and workers; `--apply` is
not a read-only probe.

Re-running with the same profile verifies the **stored** key; it does not rotate
credentials. A different/disabled named profile or another enabled embedding
provider requires a reviewed migration. Existing chat profiles are preserved.
Admin/database policy overrides take precedence over the JSON file; if they
block Gemini, review those settings instead of repeatedly re-running setup.

On failure, config or profile writes may already have committed. Keep the
printed backup path, inspect the state, and do not blindly delete/recreate keys.
Do not paste database dumps, environment files or unredacted provider errors
into issues. The helper reports controlled errors without echoing response bodies.

## Acceptance: configuration success is not indexing success

1. Check plain Intelligence chat still works through Haiku.
2. Create a small synthetic document with a unique fact, for example “The test
   delivery code is amber-seven.” Attach just this document to a new chat and
   ask for the code. Verify the answer and its source reference. Then verify an
   existing authorized document; a newly indexed test does not prove backfill.
3. Verify a member without access cannot retrieve a restricted document. Do not
   use an API-key probe as evidence of authorization correctness.
4. Check state and queue counts using the selected workspace ID:

```sh
sudo -u postgres psql -d affine -v workspace_id='REPLACE_WITH_WORKSPACE_ID' <<'SQL'
SELECT s.runtime_state, s.reason_code, i.provider, i.model_id,
       i.dimensions, i.health_status, i.last_error_code
FROM embedding_workspace_states s
LEFT JOIN embedding_indexes i ON i.id = s.active_index_id
WHERE s.workspace_id = :'workspace_id';

SELECT p.status, count(*)
FROM embedding_projections p
JOIN embedding_indexes i ON i.id = p.index_id
WHERE i.workspace_id = :'workspace_id' AND i.inactive_at IS NULL
GROUP BY p.status;
SQL
```

The expected active index uses `gemini`, `gemini-embedding-001`, dimensions
`1024`, and eventually `health_status = ready`. Pending/retry/failed projections
need investigation. A global `CopilotEmbedding` server feature or a UI saying
“100% synced” with zero documents does not prove a working workspace route.

Watch one initial indexing run:

```sh
free -h
df -h
vmstat 1 10
sudo systemctl show affine -p MemoryCurrent -p MemoryPeak
sudo journalctl -u affine --since '10 minutes ago' --no-pager
sudo journalctl -k --since '10 minutes ago' --no-pager | grep -Ei 'oom|out of memory|killed process'
```

Check logs locally; they can contain private content. Sustained swap activity,
OOM kills, a growing retry queue, or slow chat under indexing justify reducing
the indexing workload and measuring again, then adding RAM/CPU if necessary.
Do not compensate by raising Node's heap limit beyond available RAM. Provider
429 responses call for quota/backoff investigation, not a larger VM. Source
errors after a healthy route may instead concern parsing, document permissions,
pending projections or missing sources.

## Rollback

Preserve the database backup, existing private key and vector tables. Restoring
only the config backup may **not** disable the newly stored profile if Gemini
was allowed already. Remove only the exact profile created by this helper using
the native API, during a service-stop window with the same production environment
and service user as above. Record the profile ID printed by setup. In that
environment, this one-off module removes only an explicitly matched profile:

```js
// Run as affine using /opt/affine/node --input-type=module.
// Set EMBED_WORKSPACE_ID and EMBED_PROFILE_ID to the recorded, non-secret IDs.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { BackendRuntime } = createRequire(import.meta.url)(
  '/opt/affine/app/dist/server-native.x64.node'
);
const runtime = new BackendRuntime(
  await readFile('/var/lib/affine/.affine/config/private.key', 'utf8'),
  ['/var/lib/affine/.affine/config/config.json']
);
try {
  await runtime.start();
  const workspace = process.env.EMBED_WORKSPACE_ID;
  const profile = (await runtime.listByokProfiles(workspace)).find(
    p => p.profileId === process.env.EMBED_PROFILE_ID
  );
  if (
    !profile ||
    profile.name !== 'Ampixa document embeddings' ||
    profile.provider !== 'gemini'
  ) {
    throw new Error('Profile does not match; no deletion performed.');
  }
  await runtime.deleteByokProfile(workspace, profile.profileId);
} finally {
  await runtime.stop();
}
```

Then restore the config backup if no later edits need preserving (owner
`affine:affine`, mode `0640` for the bootstrap layout); otherwise revert only the
allowlist addition. Restart AFFiNE. Plain Haiku chat should remain available;
source-based chat will be unavailable without an embedding route. Do not drop
the extension, delete vector tables or restore the whole database over newer
documents just to undo this provider change.

## Local validation

```sh
node --test deploy/ampixa/enable-embeddings.test.mjs
```

Tests use synthetic keys, mocked native/provider boundaries and temporary files.
They cover config preservation/backups, idempotence, conflict refusal, correct
embedding shape, database gates, secret-safe failures and runtime cleanup. They
do not establish live Gemini access, Linux native compatibility, retrieval
quality or two-core capacity; complete the host acceptance checks before calling
deployment successful. See the [Gemini embedding API reference](https://ai.google.dev/api/embeddings)
and [model lifecycle](https://ai.google.dev/gemini-api/docs/deprecations/) before
changing models. A model change requires a separately verified index migration.
