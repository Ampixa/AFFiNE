# Import document-backed tasks

This one-time operator command copies existing Tasks metadata into the dedicated task tables. Normal task listing never runs this scan. It does not modify document snapshots, pending document updates, document permissions, rich content, or old task metadata.

## Before running

1. Validate the additive task-table schema migration and importer against an isolated database copy.
2. Back up the live database and application. Apply the reviewed schema migration through the normal release process; this command does not create tables.
3. Set `DATABASE_URL` through the protected operator environment. Never paste a connection string into a ticket, command log, or document.
4. Stop old application writers for the final import and switch. Old clients must reload after cutover. Importing while old task writers remain active can miss later legacy edits.

From the backend application directory, inspect the plan first:

```sh
node scripts/import-legacy-tasks.mjs --workspace WORKSPACE_ID
```

After confirming the backup, stopped writers and reviewed counts:

```sh
node scripts/import-legacy-tasks.mjs --workspace WORKSPACE_ID --apply --confirm-offline
```

The default is a dry run. Output contains counts, not document prose or credentials. Each workspace import uses a consistent transaction and an advisory lock. A failure rolls back its task-table changes. Run once for each intended workspace; there is no implicit all-workspaces mode.

## Preserved behavior

- Imported tasks retain `legacyDocId`. The API must continue checking that document's current read/edit permissions before returning or changing the task. Importing a private task does not make it workspace-readable.
- Titles, supported task fields, authors, timestamps and activity are copied. Rich content stays in the original document, available as the task's detail document under its original permissions.
- Source-owned opaque tokens become task/document link rows. The API still checks each linked document before exposing its ID or title.
- Trashed and orphaned task documents are skipped, as are links from trashed or orphaned sources. Missing root metadata or duplicate task tokens stops the import rather than guessing.
- Unsafe, older task-owned link metadata is not copied. Its count is reported and the original document is retained for separate review.
- A repeated import skips an already imported task entirely. It never overwrites new-table edits, duplicates activity, or resurrects links removed after migration.

## Acceptance and rollback

Compare pre/post document snapshot hashes, verify counts and activity, and test an imported private task with both an authorized and unauthorized member. Also verify a second dry run proposes zero already-imported tasks. Keep the original documents intact.

Before new-table writes begin, a code rollback can use the unchanged legacy documents. After users edit dedicated tasks, a rollback needs reconciliation of those new-table changes; legacy document metadata is deliberately no longer synchronized. Do not drop the task tables or restore an old database just to roll back application code.

Run the importer checks with:

```sh
node --test scripts/import-legacy-tasks.test.mjs
```
