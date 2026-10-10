# Kanban through MCP

Codex, Claude, and other MCP clients can discover an existing board, read its
columns and tasks, create cards, and move cards between columns. These are native
AFFiNE database rows, so the same tasks remain editable in the browser.

This requires a server build containing the Kanban tools. Reconnect the MCP client
after deployment so it refreshes `tools/list`. No new database migration is needed.
For writes, the credential must have `READ_WRITE` access, self-hosted MCP writes
must be enabled with `AFFINE_MCP_WRITE_ENABLED=true`, and the credential's user
must have `Doc.Update` permission on the document. Reading requires `Doc.Read`.

## Client workflow

1. Obtain `docId` from a document link or `doc_search`.
2. Call `list_kanban_boards` with that `docId`. Use the returned `blockId` and
   `viewId`; one document can contain several databases and views.
3. Call `read_kanban_board` with those three IDs. It returns status option IDs,
   titles, task IDs, and a `nextOffset` for pagination. The default page contains
   at most 50 tasks; the maximum is 100.
4. Call `create_kanban_task` with the three IDs, a plain-text `title`, `columnId`,
   and a unique `requestId` (8–128 letters, digits, hyphens, or underscores).
   Reuse the same request ID and arguments when retrying an uncertain result.
5. Call `move_kanban_task` with the three IDs, the returned `taskId`, and the
   destination `columnId`. Moving to its existing column does nothing.

`columnId` is the **status option ID**, not the property ID or display name. The
read result also includes `statusPropertyId` to distinguish them. Use JSON `null`
for the ungrouped column. Titles are trimmed and limited to 1,000 characters.

Example prompts after connecting a client:

> In the Release Tasks document, show me the Kanban columns and current cards.

> Create “Check release notes” in Todo on that board.

> Move that task to Done.

## Supported boards and limitations

- Version 3 AFFiNE databases with a Kanban view grouped by a **single-select**
  property, such as Status. Multi-select, checkbox, and other grouping types
  return `UNSUPPORTED_BOARD` instead of changing data.
- Reads return **all database rows in source order**, not a filtered or manually
  sorted visual view. Responses disclose `scope`, `filtersApplied: false`, and
  `hasViewFilter`. Hidden columns are identified in the result.
- Writes require an unfiltered view, a visible destination column, and the
  normal title property as the card heading. The tools do not create boards,
  create status options, change filters, reorder cards, or edit other properties.
- Moving a card changes its status and edit attribution only. Shared database
  views will reflect the same changed status.
- Create retries are recorded in the document's `mcp:kanbanRequests` Yjs map.
  An identical retry returns the original task, including its current status if
  it has since moved. Reusing an ID with different arguments returns
  `REQUEST_ID_CONFLICT`. A deleted original task is not recreated by a retry.
- MCP writes are serialized per document while reading and saving. Browser edits
  still use ordinary Yjs conflict resolution. Simultaneous edits to the same cell
  can conflict; this is not a lock on browser editing. For ambiguous cancellations,
  read the board before retrying.

## Validation and deployment smoke check

With the repository's backend test dependencies available:

```sh
yarn workspace @affine/server test src/__tests__/copilot/mcp-kanban.spec.ts src/__tests__/copilot/mcp-search.spec.ts
```

Tests cover Yjs persistence and merge behavior, retry deduplication, concurrent MCP
creates, authorization and write gates, pagination, unsupported views, aborted
actions, and storage failures. Storage, event, and mutex dependencies are fakes;
these tests do not replace a deployed browser and database smoke test.

After deployment, use a disposable test document containing an unfiltered Kanban
board grouped by a single-select Status property:

1. Discover and read the board from both clients.
2. Create one task; verify its title and column in AFFiNE.
3. Retry that creation with the same request ID; verify that only one card exists.
4. Move it to another column, then reload AFFiNE and verify the persisted status.
5. Edit its title in AFFiNE and read it again through MCP.
6. Verify that a read-only credential exposes no task mutation tools, and that a
   credential without document edit permission cannot create or move cards.

The Intelligence provider/API key is independent of these MCP tools. A chat
provider failure does not establish that an MCP task operation has failed.
