# Workspace search on the native self-hosted deployment

For a small installation without room for a search companion, see the opt-in
[bounded local keyword fallback](LIGHTWEIGHT-SEARCH.md). It trades full indexed
coverage for explicit per-request limits and needs no additional service.
The instructions below provision a persistent index for larger workspaces.

`doc_search` needs a working keyword indexer or embedding backend. An Intelligence
chat model alone does not provide either one. The native EC2 bootstrap configures
PostgreSQL, Redis and AFFiNE, but does not provision a search service; the indexer
is disabled by default.

The observed MCP failure was `SEARCH_UNAVAILABLE`. This deployment gap is a
source-based diagnosis: live server configuration and logs still need maintainer
verification. Check those before enabling a new backend, especially if the host
already has an indexer.

This change provides an optional Manticore service and a config helper. MCP now
reports an unavailable backend as an actionable `isError: true` tool result,
separate from a successful search with zero matches. Keyword-only search works
without purchasing or configuring embeddings. Document permission filtering is
unchanged. Search covers document text, not PDF/Office attachment contents,
images, audio, video or web pages.

## Maintainer deployment

Review and merge into `ampixa/selfhosted`; deployment remains a separate action.
The commands below are for the host layout in `bootstrap-affine-ec2.sh`, with
AFFiNE running natively under systemd. They are not for an AFFiNE application
container, whose loopback network would be different. Do not rerun the bootstrap
on an existing installation.

1. Confirm the effective indexer configuration, existing services, free RAM/disk,
   and backup status. Install Docker Engine with the Compose plugin if absent.
   The companion service is capped at 1 CPU and 1 GiB RAM; this is a starting
   budget, not a production capacity measurement. AFFiNE also needs headroom for
   the initial indexing jobs. Review firewall rules; port 9308 must stay private.
2. From the reviewed repository checkout, start the persistent companion:

   ```sh
   sudo docker compose -p affine-search -f deploy/ampixa/search.compose.yaml up -d --wait
   sudo docker compose -p affine-search -f deploy/ampixa/search.compose.yaml ps
   ```

   The host binding is `127.0.0.1:9308`. The image is pinned to the same version as
   server CI. A named volume holds index data across container replacement.
   If that port is occupied, investigate the existing service first.

3. Check the service and proposed configuration without writing anything:

   ```sh
   sudo /opt/affine/node deploy/ampixa/enable-search.mjs \
     --config /var/lib/affine/.affine/config/config.json
   ```

   Then apply after reviewing the result:

   ```sh
   sudo /opt/affine/node deploy/ampixa/enable-search.mjs \
     --config /var/lib/affine/.affine/config/config.json --apply
   ```

   The helper checks SQL health, preserves other settings and file ownership,
   writes atomically, and prints a private rollback backup path. It never prints
   API keys. Existing alternative endpoints/providers require manual review;
   this helper does not migrate them. Keep the backup out of Git.

4. Build and deploy the reviewed backend through the normal release workflow.
   A source merge does not replace the existing bundled `dist/main.js`.
   Run the existing self-host predeploy step with the same service environment,
   `HOME=/var/lib/affine`, and `affine` user as the bootstrap, then restart
   `affine.service`. Do not run the full bootstrap to do this.

   The predeploy entry point is `/opt/affine/app/scripts/self-host-predeploy.js`.
   It runs database and data migrations. The existing always-run
   `CreateIndexerTables1745211351719` migration creates missing search tables
   after the indexer is enabled. Review pending migrations before running them:
   an existing mixed-script migration can rebuild Manticore indexes. This PR
   adds no database migration and does not reset workspace indexing flags.

5. Allow the existing indexing queue to process documents. Initial automatic
   indexing skips already-indexed workspaces, missing root snapshots, and
   workspaces whose root snapshot is older than 180 days. A healthy search
   service does not prove backfill is complete. If replacing a previous index,
   plan and verify backfill separately; do not drop indexes or reset database
   flags just to make the health check pass.

## Acceptance checks

Use an existing authorized MCP client and a small synthetic test document:

- `read_document` succeeds for its known ID.
- `doc_search` finds a unique phrase in that document after indexing, with the
  expected document ID and excerpt. Also verify a known older document to check
  backfill. Check a document the test user cannot read is not returned.
- Without embeddings, `retrieval_mode: lexical` and
  `degraded_reason: VECTOR_UNAVAILABLE` are expected and usable.
- A phrase absent from an indexed workspace returns `hits: []`, without
  `isError`. An unavailable backend returns an explicit tool error instead.
- Confirm existing Intelligence chat still works and inspect AFFiNE/indexer
  logs for migration failures, indexing failures or memory pressure.

Investigate a missing search result before declaring deployment complete. This
PR was tested locally; acceptance on the deployed workspace remains required.

## Rollback

Restore the printed `config.json.before-search-*` backup after checking for any
configuration changes made since it was created. Restore the original owner and
mode (`affine:affine`, `0640` in the bootstrap layout), then restart AFFiNE.
If later config changes must be retained, revert only the indexer settings.

Stop the companion without deleting its data:

```sh
sudo docker compose -p affine-search -f deploy/ampixa/search.compose.yaml stop
```

Do not use `down -v`, delete the named volume, or prune volumes. Roll back a
backend release through the normal release procedure if necessary; the MCP
error-handling change itself does not modify stored documents.

## Local verification

```sh
node --test deploy/ampixa/enable-search.test.mjs
docker compose -f deploy/ampixa/search.compose.yaml config --quiet
# With the normal server development dependencies/native build available:
yarn workspace @affine/server test src/__tests__/copilot/mcp-search.spec.ts
```

The config tests cover preservation, rollback backups, dry runs, idempotence,
health failures, and refusal to silently migrate existing providers. The MCP
tests cover keyword-only retrieval, unavailable versus empty results, workspace
and document permissions, argument validation, and cancellation before execution.
