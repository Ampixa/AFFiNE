BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Additive task storage. Existing document snapshots, ACLs and history are untouched.
CREATE TABLE "workspace_tasks" (
  "id" VARCHAR NOT NULL,
  "workspace_id" VARCHAR NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'inbox',
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "assignee_id" VARCHAR,
  "due_date" VARCHAR(10),
  "blocked_reason" TEXT NOT NULL DEFAULT '',
  "legacy_doc_id" VARCHAR,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" VARCHAR,
  "updated_by" VARCHAR,
  CONSTRAINT "workspace_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "workspace_tasks_workspace_id_legacy_doc_id_key" ON "workspace_tasks"("workspace_id", "legacy_doc_id");
CREATE INDEX "workspace_tasks_workspace_id_created_at_id_idx" ON "workspace_tasks"("workspace_id", "created_at", "id");
CREATE INDEX "workspace_tasks_workspace_id_archived_status_idx" ON "workspace_tasks"("workspace_id", "archived", "status");
CREATE INDEX "workspace_tasks_workspace_id_assignee_id_idx" ON "workspace_tasks"("workspace_id", "assignee_id");
CREATE TABLE "task_document_links" (
  "task_id" VARCHAR NOT NULL,
  "doc_id" VARCHAR NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_document_links_pkey" PRIMARY KEY ("task_id", "doc_id"),
  CONSTRAINT "task_document_links_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "workspace_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "task_document_links_doc_id_task_id_idx" ON "task_document_links"("doc_id", "task_id");
CREATE TABLE "task_activity" (
  "id" VARCHAR NOT NULL,
  "task_id" VARCHAR NOT NULL,
  "actor_id" VARCHAR,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_activity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_activity_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "workspace_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "task_activity_task_id_created_at_idx" ON "task_activity"("task_id", "created_at");

COMMIT;
