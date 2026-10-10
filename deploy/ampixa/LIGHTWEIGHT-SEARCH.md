# Document search on a small self-hosted server

An installation can have working Claude chat and selected-file support while
Intelligence's `doc_search` still returns `SEARCH_UNAVAILABLE`. A chat API key
does not provide an embedding service, and the native deployment does not enable
a keyword indexer by default.

This opt-in fallback searches persisted Page and canvas text using the existing
PostgreSQL document storage and native projection code. It adds no service,
model, credential, package or database migration. Both Intelligence and workspace
MCP use it when **both** indexed retrieval channels are unavailable. A healthy
index with zero matches keeps its normal empty result.

## Scope and permissions

- Search stays inside the current workspace. It does not search every workspace
  in an organization or grant extra access to a user.
- Workspace AI and document indexing settings must be enabled. Documents opted
  out of AI are excluded. The existing opt-out remains meaningful even though
  this fallback does not create an embedding index.
- Live root metadata excludes trash and orphan snapshots. Each document must
  pass the caller's `Doc.Read` check before its bytes are read. Returned hits are
  checked again for permission and AI opt-out before returning.
- Optional `doc_ids` narrow this scope; they cannot expand it. Cached text never
  substitutes for permission checks. A changed workspace root aborts the scan
  rather than returning potentially removed content.
- Search is literal Unicode keyword matching, not semantic retrieval. Results
  include document and block/canvas locators and short passages. This is source
  data for the model, not an authorization mechanism or trusted instructions.
- PDF, Office, image, audio, video and external URL contents are not scanned.
  Explicitly selected files retain the separate
  [Claude file-chat flow](claude-files/README.md). This feature does not make
  `artifact_search` an embedding-free search engine.

## Resource limits and coverage

Reads are sequential, with one fallback scan admitted per application process.
Concurrent scans receive the existing retryable search-unavailable tool error.
There is no background indexing job.

| Limit                                                    | Behavior                                                                                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 256 readable documents per scan                          | Later documents are skipped; a narrower `doc_ids` search can reach them.                                                                                                                       |
| 16 MiB scan input budget                                 | Checked between documents; one final document can exceed the budget by at most 1 MiB. The root is read again for consistency.                                                                  |
| 5-second soft scan deadline                              | Checked between operations; does not cancel an in-flight database query or native decode.                                                                                                      |
| 1 MiB and 128 stored parts per document/root             | PostgreSQL checks snapshot plus pending updates before returning binary data. Oversized documents are skipped, never parsed as a prefix. An oversized/missing root makes fallback unavailable. |
| 256 KiB projected JSON per document                      | Larger projections are excluded.                                                                                                                                                               |
| 8 MiB serialized projection cache, at most 128 documents | Process-local, bounded, and invalidated by the current document hash. These are payload budgets, not a guarantee about total process RSS.                                                      |
| 20 hits, at most 3 per document                          | Each excerpt is at most 1,000 characters, with a title of at most 300 characters.                                                                                                              |

The result reports `retrieval_mode: local-keyword`,
`degraded_reason: INDEXED_SEARCH_UNAVAILABLE`, and a `coverage` object. An
incomplete scan includes skipped counts and an instruction not to claim that an
absent fact or document does not exist. Even complete keyword coverage does not
mean semantic recall: try a phrase actually present in the document. For larger
workspaces, provision and verify the [keyword indexer](SEARCH.md) instead.

Only the bounded matching passages enter the tool result; this fallback does
not insert the whole workspace into every chat prompt. Normal chat-provider
token charges still apply. Previously returned answers and chat history keep
their existing retention behavior.

## Deployment after review and merge

Build the reviewed backend on the build machine and deploy its artifact through
the [manual release procedure](MANUAL-RELEASE.md). Do not compile the monorepo or
start a search/model container on a small production host. Preserve the existing
file-chat gateway, keys, uploads, database and service configuration.

For the systemd deployment, add these two non-secret settings to the existing
service environment file (normally `/etc/affine/affine.env`), preserving all other
values and its current permissions:

```dotenv
AFFINE_COPILOT_DOCUMENT_SEARCH_FALLBACK=true
AFFINE_COPILOT_DISABLE_REASONING=true
```

Both settings default to `false`. The second rejects Extended Thinking with the
existing actionable “turn off Extended Thinking” error before a chat-provider
request. Use it for a gateway that cannot accept reasoning options; it is an
installation-wide chat setting, not a claim that every Claude model lacks
reasoning. Ordinary chat, file chat and tools remain enabled. The browser toggle
is still visible; this change enforces the restriction on the server.

After deploying the reviewed backend and editing the environment, restart only
AFFiNE through the usual release process. No extension update, file-chat
reprovisioning, embedding credential or new daemon is required.

## Acceptance before announcing availability

Use synthetic, non-sensitive documents and an ordinary test member:

1. With Extended Thinking off and Workspace All Docs on, ask for a unique fact
   in a synced, readable Page that was **not selected** in the chat. Inspect the
   document-search tool result and its source, not just the assistant's answer.
2. Edit and sync the fact, start a fresh chat, and verify the new passage. Repeat
   for canvas text. Narrow by document ID if the scan reports partial coverage.
3. Verify a private document, a trashed document, a different workspace's
   document and an AI-excluded document do not appear. Repeat after changing
   access on a previously found document.
4. Search for an absent phrase. Verify an empty result is successful and coverage
   is disclosed; a busy or unavailable scan must remain a tool error.
5. Turn on Extended Thinking. Verify the actionable unsupported-options error,
   with no corresponding provider request. Turn it off and verify normal chat.
6. Recheck selected PDF/DOCX/image chat and the authorized MCP read/create/move
   Kanban flow. Their existing capabilities and permissions are unchanged.
7. Observe `free -h`, `vmstat 1 5`, service memory and recent AFFiNE/gateway logs.
   Do not interpret a healthy `/info` response as proof document retrieval works.
   Resource pressure, partial scans and deployment acceptance remain operational
   checks; local tests cannot establish production capacity.

## Local verification

In a prepared checkout with the repository's supported Node version, dependencies
and native backend built:

```sh
yarn workspace @affine/server test \
  src/__tests__/copilot/local-document-search.spec.ts \
  src/__tests__/copilot/local-search-postgres.spec.ts \
  src/__tests__/copilot/mcp-search.spec.ts \
  src/__tests__/copilot/capability-runtime.spec.ts \
  src/__tests__/copilot/native-errors.spec.ts \
  src/__tests__/copilot/runtime-boundaries.spec.ts \
  src/__tests__/copilot/mcp-kanban.spec.ts \
  src/__tests__/copilot/selected-document-context.spec.ts \
  src/__tests__/copilot/selected-file-context.spec.ts
yarn workspace @affine/server build
```

Set `LOCAL_SEARCH_TEST_DATABASE_URL` to a **disposable local PostgreSQL** database
to include the SQL test; otherwise that test is skipped. It uses transaction-local
temporary tables. The other fixtures exercise real Yjs updates and native
document projections with mocked permissions/storage or provider interfaces.
They do not call Anthropic or use production documents.

## Rollback

Set the fallback flag to `false` and restart AFFiNE to restore the prior search
behavior, or redeploy the previous backend artifact. Leave the reasoning guard
enabled if the gateway still rejects reasoning. There is no index, schema or
persistent cache created by this fallback to delete.
