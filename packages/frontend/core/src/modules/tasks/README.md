# Workspace tasks — dedicated task storage

## Current architecture

Signed-in workspace tasks are database rows, fetched through the authenticated workspace Tasks API. Loading Tasks does not enumerate document IDs, fetch document snapshots, initialize editors, or write Yjs records. Task title, description, status, assignee, priority, target date, blocker, archive state and activity are independent of supporting documents. The existing AFFiNE theme, list/board views and member selector are retained.

Document connections are separate relationships. The API filters linked IDs/titles with fresh document access checks; linking never grants permission. The client establishes permission listeners for returned linked documents and imported original documents before exposing their metadata, and re-fetches until new relationship additions are covered. Access-change events clear task/context state immediately; stale in-flight responses cannot restore it. The context picker searches authorized metadata only after two characters are entered and paginates results without reading document bodies. Related tasks uses the same direct list API filtered by document ID.

The task list follows opaque pagination cursors (including empty permission-filtered pages), refreshes every 30 seconds while visible, and revalidates on focus. This iteration does not yet push task field changes in realtime; permission events still invalidate immediately. Mutations use server-side optimistic version checks and CSRF protection. Confirmed writes whose follow-up verification fails are reported without replaying the mutation. Original imported document details remain accessible only when the server returns an authorized original-document ID.

Local-only workspaces show that team tasks require a signed-in workspace. Existing local task documents are not scanned, deleted, or rewritten by this view. The one-time legacy import is a separately reviewed server migration; there is no automatic document scan on an ordinary Tasks request.

## Validation scope

Frontend hook tests use real React state with mocked HTTP/identity/event services. They verify constant-request discovery independent of workspace document count, pagination, private-context invalidation, stale-response rejection, subscription stabilization, CSRF/version handling and no automatic mutation replay. Component tests cover assignment, description editing, permission downgrade, stale drafts, context filtering and archive controls. Authenticated local replica checks and measured request timings must precede deployment; passing mocked tests alone is not a production performance claim.

## Historical document-backed implementation and evidence

The sections below describe earlier releases and their observed validation. They are retained as provenance, not the current storage design.

### Original local first-release preview

Tasks are AFFiNE documents, not a separate application or database. The desktop workspace sidebar opens `/tasks`; documents expose **Info → Related tasks** as well as the document-info dialog. Existing AFFiNE theme tokens and layout are retained.

## Implemented

- Native list and board; search, status/priority filters, My work, Needs attention and Archived views.
- Title, owner via the existing workspace member picker, flexible status, priority, optional target date, blocker reason and archive/restore.
- Context documents are resolved only when both documents are readable. Creating a connection requires edit access to both endpoints.
- Source-document related-task listing and creation, with ordinary editor navigation.
- Description, checklists, attachments and discussion use existing document/editor features rather than a second implementation.
- Per-document task activity records and stale-draft checks against already-synced edits.

## Storage and access

`ampixa:task` and `ampixa:task-history` are Yjs maps on each task document. A task owns a random connection token; the source document stores that token in `ampixa:related-tasks`. Neither endpoint stores the other document’s ID or title. The client joins tokens only across readable documents; these connections do not insert native BlockSuite references or automatically create graph edges. Fields and relation entries merge independently. History keys are unique; this is collaboration history, not a tamper-proof audit log. Normal same-field Yjs conflict resolution still applies to concurrent/offline edits; stale-draft checks are not a server-wide compare-and-swap guarantee.

Cloud read/update checks run before access and writes; workspace and document access events invalidate displayed data. Assignment accepts only accepted workspace members and never grants document access. Source lists and related tasks only include readable documents. Local non-shared workspaces work offline and intentionally have no invented member directory.

Discovery reads authorized cloud snapshots into isolated Yjs documents while the view is mounted. Focus and periodic refresh recheck access. Two workers share an active scan rather than restarting it; a five-second snapshot-load timeout reports incomplete coverage. Realtime listeners cover actual tasks and linked sources and must be ready before those connections are published. Local/offline workspaces retain native document discovery. Production-scale acceptance is required before deploying this revision.

Legacy preview `ampixa:task-links` entries and native references are detected and blocked from further linking, not silently deleted or migrated. The explicit Remove legacy links action removes matching current references and legacy map entries while preserving text, unrelated links and source documents. Earlier sync history and backups remain unchanged. Revocation hides further access; it cannot erase information a previously authorized client already downloaded. Source readers can see opaque relation tokens/counts, but those do not reveal unreadable task identities.

## Initial synthetic-preview validation

The initial AFFiNE frontend was tested against an isolated cached backend release (`31392784ce0edc579c31ab26fffa1c3608b720ac`). Relevant authentication, permissions, sync, membership and realtime backend source matches this checkout. Only synthetic accounts and documents were used.

Separate authenticated editor and reader browser sessions verified accepted-member assignment, My work, persisted status changes, reader controls and pending-invitee assignment rejection. While task details stayed open, an actual permission downgrade disabled editing and removed mutation controls; full revocation replaced the details with an unavailable message. Pristine reader details reflected remote status changes live.

Granting access to a linked private source made its context appear for the editor. Revoking that grant removed it without reloading the open task, while the shared context remained. The other reader never saw the private context. Shared context added by the editor appeared live for the reader. These tests cover task-context presentation, not a redesign of AFFiNE's workspace metadata privacy boundary.

All three original synthetic offline preview tasks had their current legacy links removed through the native confirmation flow, preserving titles and statuses. The checklist source was re-linked using an opaque token and verified after navigation; its obsolete inline reference was absent from the ordinary document. Historical sync data and backups were retained.

Four test files passed 44 tests covering task models, real-hook/Yjs behavior, component permissions and sync recovery. Hook/component services are mocked and complement the authenticated browser checks above. Eight of these tests cover document sync, including recovery of a newly readable older document without remote writes. The nbstore declaration build and full frontend-core TypeScript check passed.

Additional isolated server checks passed: 25 checks with five synthetic accounts and seven realtime transport checks for permission changes and subsequent read/write enforcement. Browser testing also fixed denied-document scan handling, subscription-ready invalidation loops, stale pristine details, delayed document hydration and targeted recovery after a new read grant.

## Before publication/deployment

- Expand browser coverage for simultaneous same-field writes and membership removal during an unsaved draft.
- Measure discovery on a large workspace, including slow/failed document sync.
- Validate existing cloud comments end-to-end; this preview reuses the document editor rather than introducing task-specific comments.
- Review localization and agreed product wording.
- Context removal, notifications, reviewer assignment, dependencies, custom workflow configuration and task-specific graph overlays are not part of this first preview.

The initial synthetic preview used no production workspace data. The subsequent discovery fix adds an authenticated backend read endpoint but no schema migration. Production-scale validation uses a separate, private, credential-sanitized local replica.

## Production-scale discovery safeguards

Cloud discovery reads isolated Yjs snapshots through an authenticated, per-document authorized endpoint. It does not open the editor, run editor migrations, enqueue sync retries, record document visits, or compact pending updates into persisted snapshots. The endpoint merges pending updates in memory only. Explicit create/edit/link actions still use the ordinary document editor and fresh write-permission checks.

Scanning is bounded to two concurrent documents and reports progress. Five-minute fallback scans pause in hidden tabs; focus refreshes are rate-limited, while permission events still invalidate access immediately. Creation becomes available after workspace permission verification instead of waiting for the full scan. The local storage observer applies updates only to isolated snapshots; it cannot publish them back. Large-workspace acceptance must include unchanged document contents and snapshot/update counts, limited database pools, responsiveness of existing documents, and access revocation while task details are open.

## Production-scale replica evidence

The Linux release checks passed 63 frontend/sync tests, 34 gateway tests and 128 backend tests. Seven authenticated HTTP checks confirmed per-document authorization, grant/revoke enforcement, no-store responses, and in-memory merging without persisted snapshot/history/analytics changes.

A two-minute, non-admin browser discovery and refresh interval changed no snapshot bytes or metadata and created no pending updates or database errors. Six concurrent non-admin cold scans (two workers each) completed 4,140 requests in 36.2 seconds with expected permission denials, no pool/transaction timeouts, and approximately 302 MiB peak application memory under a 2 GiB/0.9-CPU limit. These are local observations, not production latency guarantees; shared-host CPU contention must be checked during rollout.

Browser validation confirmed task creation, member assignment, context linking, status persistence, private context filtering, and live downgrade/revocation. It also exposed a missing durable sync acknowledgement for explicit writes; that follow-up requires renewed archive/restore and reload acceptance before deployment.
