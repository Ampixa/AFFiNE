# Tasks, conversations and Intelligence

Tasks are shared memory for flexible work, not a productivity scorecard. Existing
AFFiNE theme, optional dates, list/board and My work remain. No sprint, points,
ranking, mandatory reporting or new service is introduced.

## Permissions

Active workspace members can read accessible tasks and comment. Only a comment's
author can edit it. Comments show author, time and an edited indicator; activity
records that a comment was added or edited, not every historical comment body.
Comments are plain text with HTTP(S) links. They do not fetch remote previews or
grant access to linked documents. Share only information appropriate for task
readers: writing private information into a comment makes that text visible to
them even if the original document remains private.

Assigned members can update description (including Markdown checklists), status
and blocker. Workspace administrators control creation, title, assignment,
priority, target date, document relationships and archive/restore. Server checks
apply to direct API calls as well as UI and MCP; controls are not the security
boundary. Imported tasks retain their original document access boundary.

## Intelligence

With document reading enabled, chat can list/read accessible workspace tasks and
propose progress edits to tasks assigned to the signed-in user. Even an admin
cannot use Intelligence to edit someone else's task. Task creation, reassignment,
priority, deadline, archive and title changes are not offered through chat.

Nothing is saved by the model. Apply/Cancel previews use the current user's
conversation, expire after 15 minutes and recheck ownership and permissions on
apply. Version conflicts require a fresh preview. Claims and receipts prevent
replaying an ambiguous apply. Task activity records the human actor. Existing
chat messages may retain previously authorized text; revocation does not erase
old conversations.

## MCP

Read tools: `list_tasks`, `read_task`, `list_task_members`,
`list_task_comments`. Write credentials additionally expose `create_task`,
`update_task`, `link_task_document`, `add_task_comment`, `edit_task_comment`.
Write scope never bypasses the user's role. Update uses `expectedUpdatedAt`
from a fresh read. Archive/restore uses the `archived` field; there is no hard
-delete task tool. Comments paginate in groups of 50 using offset cursor.
Read task lists until `nextCursor` is null. After an uncertain create/comment,
read back before deciding whether another submission is appropriate.

## Release gates

Additive `20261115190000_task_comments` migration creates only `task_comments`.
Use the existing reviewed migration/backup/restore procedure; never run a schema
reset or build on the small production VM. Deploy frontend and backend together.
Keep the comment table if rolling back so saved discussion remains recoverable.

Required acceptance: multiple users, ownership/revision change while editor or
AI preview is open, admin downgrade/member removal, other-author comment edits,
read-only MCP, cross-workspace calls, private context revocation, escaped HTML
and unsafe schemes, duplicate Apply, conversation pagination and refresh. Test
both API and actual browser flows. Do not equate mocked tests with production
acceptance. No deployment is implied by this document.
