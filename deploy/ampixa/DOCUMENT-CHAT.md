# Selected-document chat without an embedding provider

An installation can have working Claude chat and still fail when a Page is
selected in Intelligence. The selected-source preflight normally requires a
working embedding route. An Anthropic chat key does not supply that route:
[Anthropic does not offer an embedding model](https://platform.claude.com/docs/en/build-with-claude/embeddings).

This change allows small selected Pages to be sent as text context to the
installation's existing chat provider when embeddings are unavailable. It adds
no model process, API credential, database migration, or new service for Pages.
An optional [Claude file-chat route](claude-files/README.md) extends this to
explicitly selected PDF/DOCX/TXT/image files with upload reuse and prompt caching.
Ordinary provider token charges still apply to the document text included in each request.

## Behavior and limits

- Both `/chat/:sessionId/stream` and `/chat/:sessionId/stream-object` support the
  fallback. Intelligence uses the latter.
- At most four unique selected documents, with at most 32 KiB of combined UTF-8
  context including JSON metadata. Sources are never silently truncated.
- Snapshot size metadata must be present and at most 1 MiB per document before
  Markdown conversion. Reads are sequential. This is a preliminary safeguard,
  not a bound on the complete AFFiNE process's memory: indexing preflight,
  document-service reads, and pending document updates retain their existing
  resource behavior.
- Workspace AI and document indexing settings must remain enabled. An explicit
  opt-out, disabled document-reading tool, missing document, access denial,
  unsupported content, or an oversized selection fails closed.
- The current caller's `Doc.Read` permission is checked for every document on
  each request, including retries of an older accepted turn.
- Only persisted Page text is included. Canvas content, linked pages, external
  URLs, and attached PDF/Office/image contents are not loaded by this fallback.
  Empty Pages and unknown/unsupported Markdown blocks are rejected; structural
  note/surface container reports do not reject otherwise readable Page text.
- Context carries document IDs, titles, and persisted revisions, is marked as
  untrusted source material, and stays out of the system role. This labeling is
  not a guarantee against prompt injection; existing tool permissions still apply.
- The extra source message is not appended to the stored conversation or the
  controller's error diagnostics. It is reconstructed after access checks on
  every turn. Normal answers and their existing persistence rules are unchanged.
- Healthy embedding retrieval is unchanged. Processing, failed-indexing, and
  selection-limit errors are not converted into fallback responses. Mixed
  document/artifact selections keep their previous behavior unless the separate
  Claude file-chat route is enabled. Image generation remains unchanged.

This does **not** enable vector search across the workspace or populate an
embedding index. Existing keyword search can operate separately when provisioned;
see [SEARCH.md](SEARCH.md). An embedding status of `embedding_route_unavailable`
may remain even while bounded selected-Page chat works.

## Build and verification

Use the repository's normal supported build environment; do not compile the
monorepo on an undersized production VM while AFFiNE and PostgreSQL are running.
Run the focused backend test in a prepared checkout:

```sh
yarn workspace @affine/server test src/__tests__/copilot/selected-document-context.spec.ts
```

The local development check used Node 24 with an isolated AVA harness: actual
fallback, orchestrator, chat-query schema and tool-option code, with database,
permission, reader, runtime and infrastructure dependencies replaced by fixtures.
It is a logic regression check, not a live PostgreSQL/native-runtime or Anthropic
integration test. Run the normal backend build/tests before deployment.

## Deployment acceptance

The maintainer deploys the reviewed backend artifact through the normal release
process. Keep the previous artifact available for rollback. No additional
provider key or database command is required by this change.

Use synthetic, non-sensitive Pages for acceptance:

1. Confirm ordinary Intelligence chat works with the existing Anthropic route.
2. Keep workspace AI and document indexing enabled, with no embedding provider.
3. Create and sync a small text Page containing a unique fact, for example
   `The demonstration release codename is Amber Lantern.` Select it in a new
   Intelligence chat and ask for that codename. Verify the answer uses the Page.
4. Update and sync the fact, then ask again. Verify the updated persisted content
   is used rather than a previous answer or a cached context message.
5. Test with two readable Pages. Then remove the test caller's access to one and
   retry an earlier turn. Verify it fails without sending a partial selection.
6. Select five distinct Pages, and separately test a Page whose text exceeds the
   total context cap. Verify a selection-limit error and no provider request.
7. Disable document reading or workspace AI/indexing and verify the fallback does
   not bypass the setting. With the file-chat opt-in unset, mixed file selections
   must retain their existing error; with it enabled, follow its separate
   acceptance protocol.
8. Observe latency and memory under modest concurrency, and verify error logs do
   not contain the injected Page content. The input cap does not guarantee that
   all deployments have enough memory for their other services.

For a small VM with full swap, inspect active paging before adding load:

```sh
free -h
vmstat 1 5
ps -eo pid,comm,rss --sort=-rss | head -15
```

Full swap alone does not prove current paging; examine `si` and `so` after the
first `vmstat` sample. Do not clear swap as a repair while RAM is constrained.
If normal AFFiNE/database load is already exhausting resources, increase capacity
or reduce that load before acceptance. This fallback avoids a local embedding
model, but it does not repair an existing resource shortage.

## Rollback

Redeploy the prior backend artifact. There is no schema or provider configuration
change to undo. Selected-document chat will again require the existing embedding
preflight to succeed; ordinary chat and stored workspace data remain intact.
