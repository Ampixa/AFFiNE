# Claude file chat with upload reuse and prompt caching

This opt-in route lets Intelligence read explicitly selected PDFs, Word DOCX
files, UTF-8 text and JPEG/PNG/GIF/WebP images using the installation's existing
Anthropic API key. It does not require an embedding provider. A small Node
service translates AFFiNE's OpenAI Responses requests into Claude Messages and
Files requests. PDF/image interpretation and Word extraction happen on
Anthropic's infrastructure; the VM runs no OCR, embedding model, Office suite,
Python interpreter or document extraction worker for this route.

The existing LiteLLM chat gateway remains available. A separate Responses route
is necessary because the pinned `llm_adapter` 0.2.20 chat-completions serializer
drops generic file attachments. Enabling file capabilities on that old route
would not fix PDFs or DOCX.

## What is reused

1. AFFiNE stores an immutable workspace artifact and checks the current caller's
   access on **every** turn, including retries. Workspace membership, AI/indexing
   settings, artifact readiness and conversation ownership are checked. A
   conversation upload is accepted only in its owner's current conversation;
   library-owned artifacts follow workspace membership. Deleted or inaccessible
   selections fail without sending a partial selection.
2. The backend reads selected bytes sequentially with a bounded storage call and
   verifies AFFiNE's SHA-256 base64url artifact hash. It sends those bytes over
   loopback to the gateway. This local read/transfer still happens each turn.
3. The gateway uploads each distinct file once and keeps at most 128 **file-ID
   metadata entries**, keyed by content hash and MIME type. IDs are reusable for
   up to 55 minutes, within the provider-confirmed one-hour file expiry. Changed
   bytes cause a new upload. Restarting the gateway loses this memory-only cache;
   there is no disk copy of file content or cached answer in the gateway.
4. Each Claude request references the selected files and enables automatic
   five-minute prompt caching. Follow-up messages append after a stable source
   prefix. An actual hit requires a qualifying unchanged prefix, enough tokens,
   and an unexpired provider cache. Inspect `usage.input_tokens_details.cached_tokens`
   and `cache_creation_tokens` on the Responses reply; don't assume every request
   hits. File-ID reuse by itself does **not** remove input-token charges.

This sends the **selected files**, not every document in the workspace. Their
content still occupies model context on each question. Large-library semantic
retrieval requires a separate retrieval/indexing design. DOCX processing may run
again on a follow-up; the gateway does not retain extracted Word text or reuse
execution containers across requests.

## Resource and format boundaries

| Limit                              | Value                                       |
| ---------------------------------- | ------------------------------------------- |
| Files per turn                     | 4                                           |
| One file                           | 5 MiB                                       |
| Combined decoded file bytes        | 8 MiB                                       |
| Gateway JSON body                  | 12 MiB, including history                   |
| Upstream response                  | 2 MiB per request                           |
| Active gateway requests            | 1; excess requests get 429, no queue        |
| Active backend selected-file reads | 2 per process                               |
| Gateway request deadline           | 180 seconds, including hosted continuations |
| Hosted continuation limit          | 3 Claude Messages requests total            |
| Node JS heap target                | 128 MiB                                     |
| systemd memory high / hard cap     | 160 MiB / 224 MiB                           |

These are application/service limits, not a promise that AFFiNE, PostgreSQL and
all other processes fit into a 2 GiB VM. Native buffers and transport copies also
use RAM. Initial upload/storage and unrelated indexing retain their existing
resource behavior. Observe real RSS and paging during acceptance. Build release
artifacts elsewhere, never on a memory-constrained production VM.

- PDFs and images use native Claude document/image blocks. Scans, unusual fonts,
  page counts and model context limits still need real-file acceptance testing.
- DOCX uses Anthropic's hosted `code_execution_20250825` tool. It can read
  paragraphs and tables. Embedded images and layout are not guaranteed; export
  those documents as PDF when visual fidelity matters. Hosted-tool usage may
  incur additional Anthropic charges on the same account.
- Legacy `.doc`, spreadsheets, video and unsupported MIME types fail explicitly.
  Nothing installs a local converter. TXT must be UTF-8.
- This gateway provides the Responses SSE envelope expected by AFFiNE but emits
  answer events **after Claude finishes**. Heartbeat comments keep the stream
  alive while waiting; this is not token-by-token streaming or a TTFT improvement.
- Client function tools and structured output are translated. AFFiNE remains
  responsible for executing and authorizing its client tools. The file path
  excludes artifact-read/search tools to avoid triggering local file extraction.
  Reasoning and web search are not supported by this route.
- Errors do not expose file bytes, provider error bodies or API keys. Provider
  failures do not cause automatic replay of a paid request. Some 400/404 failures
  invalidate cached IDs so the next manual retry uploads again.

## Provider storage and credentials

The gateway uses one Anthropic credential/workspace and one AFFiNE workspace per
instance. Do not share an instance across unrelated tenants. Keep file IDs
server-side: Anthropic file access is scoped to its workspace, not an AFFiNE user.
Only backend-materialized bytes are accepted; arbitrary URLs, local paths and
caller-supplied provider IDs are rejected.

Uploads request `expires_in_seconds=3600` and require a valid `expires_at` response.
Missing expiry confirmation triggers best-effort deletion and fails the request.
Expiry limits API accessibility; it is not a guarantee of immediate physical
removal or zero retention. Anthropic's file and hosted-container retention rules
apply; hosted execution containers can persist separately from uploaded files.
Review them for the documents being used.

Provider references:
[Files API](https://platform.claude.com/docs/en/build-with-claude/files),
[prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support),
[hosted code execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool).

## Maintainer deployment

This is a separate, explicit deployment step after review. No deployment is
performed by the local test commands.

1. Build and test the reviewed backend **and matching native module** together.
   The bounded `StorageRuntime.getObject(..., maxBytes)` binding is new; deploying
   only JavaScript against an old native binary would not enforce the native cap.
   Keep the previous backend/native artifact pair for rollback. No database
   migration or additional PostgreSQL extension is required by this feature.
2. Check available memory and active paging (`free -h`, `vmstat 1 5`). Resolve an
   existing shortage before starting another service. The file gateway requires
   Node 22+ with built-in `fetch`, `FormData` and `Blob`, and no npm dependencies.
3. Install this directory under `/opt/affine/ai-gateway/claude-files`, owned by the
   existing `affine` service user. Install `affine-claude-files.service` into
   `/etc/systemd/system`. Its loopback-only endpoint is port 3012. It reuses the
   existing `/etc/affine/ai-gateway.env` with `ANTHROPIC_API_KEY`, optional
   `ANTHROPIC_WORKSPACE_ID`, and `LITELLM_MASTER_KEY`; do not expose that file or
   copy the Anthropic key into a workspace profile. Keep gateway credentials
   distinct from the Anthropic key. The unit uses `/opt/affine/node`, the same
   Node 22 runtime as `affine.service`; Ubuntu's `/usr/bin/node` can be older.
   Verify `/opt/affine/node --version` before installing the unit. For another
   installation layout, change `ExecStart` to its verified Node 22 path.
4. Start the gateway and inspect its service status. Do not expose port 3012 in
   the reverse proxy or firewall. The existing 3011 LiteLLM route is retained.
5. As the `affine` user, with its normal production and gateway environment
   already loaded, provision the additional profile:

   ```sh
   /opt/affine/node /opt/affine/ai-gateway/claude-files/provision.mjs /secure/path/workspace-owner.json
   ```

   The JSON contains exactly one `{ "workspaceId": "...", "actorUserId": "..." }`
   record in an array; use the workspace owner's account. The script adds/reuses
   **Claude Haiku file chat**, leaves existing profiles/bindings intact, and probes
   chat, structured output and function calling using small paid Claude requests.
   It refuses to overwrite a mismatching existing profile. This is not a PDF/DOCX
   acceptance test. If probing fails, leave the workspace opt-in unset and inspect
   or disable the newly created profile before continuing. A new enabled profile
   can participate in native route selection; recheck ordinary Auto chat too.

6. Only after probes pass, put the printed `AFFINE_CLAUDE_FILE_PROFILES` JSON map
   and `AFFINE_CLAUDE_FILE_MODEL` into the **AFFiNE backend's** environment. These
   are IDs/model configuration, not secrets. The backend and gateway must use the
   same model; the default matches the existing `claude-haiku-5-5` installation.
   For another supported model, set gateway `CLAUDE_FILE_MODEL` consistently before
   provisioning. Restart AFFiNE with the matching backend/native build.
7. In Intelligence, select Auto or **Claude Haiku file chat**, enable document
   reading, and leave reasoning/web search off. Workspace AI and document indexing
   must stay enabled as consent controls even though no embedding route is used.
   An unavailable embedding status can remain; this feature does not fix it.

### Unsupported chat options

The file-chat gateway rejects Extended Thinking and web search, including when
Auto selects this profile for a text-only or selected-Page request. AFFiNE maps
that known rejection to `COPILOT_UNSUPPORTED_CHAT_OPTIONS` (400 semantics) and
shows instructions to turn those options off in the model menu and send again.
An already-open SSE response keeps its HTTP status and carries the error in its
error event. There is no automatic retry or silent removal of requested options.
Deploy the backend and frontend together for the actionable chat message; the
mapping also recognizes the existing gateway's error, so this fix does not
require a gateway update, migration, or configuration change. Other provider
failures retain their existing error handling.

## Tests and acceptance

Local commands from the repository root:

```sh
node --test deploy/ampixa/claude-files/gateway.test.mjs
node --check deploy/ampixa/claude-files/provision.mjs
node deploy/ampixa/claude-files/memory-smoke.mjs
yarn workspace @affine/server test src/__tests__/copilot/selected-file-context.spec.ts src/__tests__/copilot/selected-document-context.spec.ts
```

The gateway suite uses Node's test runner, a real loopback HTTP server, and a mocked
Anthropic transport. Binary fixtures are protocol fixtures, not representative
PDF/Word parsing tests. The local backend check uses actual context/orchestrator/
admission code in an isolated AVA harness with infrastructure fixtures. It does
not establish native-build, live database, actual cache-hit or Anthropic file
compatibility. Run the normal backend/native build in the supported build
environment before rollout.

Local validation on macOS/Node 24: 28 gateway tests and 43 focused backend tests
passed. The artifact query also type-checked against a Prisma client generated
from this repository's schema. The synthetic memory smoke sent two distinct
4 MiB PDF protocol fixtures for three turns to a separate gateway process with
`--max-old-space-size=128`: two uploads total, about 173 MiB peak RSS. This measures
only the gateway with a mocked provider on a developer machine; it excludes
AFFiNE/PostgreSQL, native integration, Linux systemd behavior, actual file parsing
and real provider/cache costs. It is not a production capacity certification.

Acceptance uses synthetic, non-sensitive documents:

1. Test one PDF, DOCX (paragraph plus table), PNG/JPEG with readable text, and TXT.
   Each should contain a different unique fact; ask for the fact and verify it.
   Also test an actual scanned PDF separately.
2. Ask a follow-up with the same selected files. Confirm only one Files upload
   per unique binary during its reuse window, and inspect provider cache usage
   for a sufficiently long unchanged prefix. Short prompts may legitimately miss.
3. Edit/replace the source and verify the new fact is used. Test after gateway
   restart and file expiry. Failures must not silently answer without the file.
4. Revoke membership, delete a file, disable AI/indexing, and retry an earlier turn.
   Also try selecting another user's private conversation artifact. Verify denial
   before provider upload; a library-owned file remains visible to members.
5. Reject five files, one over 5 MiB, a combined selection over 8 MiB, `.doc`, a
   bad signature and a foreign provider file ID. A second simultaneous request
   should get a busy error; cancellation must release the active slot.
6. Test a selected Page plus file with no embeddings, ordinary Auto chat, function
   calls and structured replies. Keep existing Page-fallback checks from
   [DOCUMENT-CHAT.md](../DOCUMENT-CHAT.md).
7. Inspect process RSS, systemd memory events and paging during near-limit uploads
   and follow-ups. Validate actual provider costs and timeouts. A service cap that
   gets hit is a failed capacity test, not proof that the VM is healthy.

## Rollback

Remove the workspace entry from `AFFINE_CLAUDE_FILE_PROFILES` (or unset it), restart
AFFiNE, disable the additional file-chat BYOK profile, and stop/disable
`affine-claude-files.service`. Preserve original profiles and the 3011 gateway.
Existing Pages, stored files and conversations are retained. If rolling back the
code too, restore the prior backend/native pair together. File selections then
return to the previous behavior; provider-side uploads follow their expiry rules.
