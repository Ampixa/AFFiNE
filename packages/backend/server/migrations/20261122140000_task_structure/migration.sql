-- Additive: existing task records and document links remain intact.
ALTER TABLE "workspace_tasks"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'task',
  ADD COLUMN "parent_id" VARCHAR,
  ADD COLUMN "estimate" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "done_when" TEXT NOT NULL DEFAULT '';
ALTER TABLE "workspace_tasks" ADD CONSTRAINT "workspace_tasks_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "workspace_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "workspace_tasks_workspace_id_parent_id_idx" ON "workspace_tasks"("workspace_id", "parent_id");
CREATE TABLE "task_dependencies" (
  "task_id" VARCHAR NOT NULL,
  "blocker_id" VARCHAR NOT NULL,
  CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("task_id", "blocker_id"),
  CONSTRAINT "task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "workspace_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_dependencies_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "workspace_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_dependencies_no_self" CHECK ("task_id" <> "blocker_id")
);
CREATE INDEX "task_dependencies_blocker_id_task_id_idx" ON "task_dependencies"("blocker_id", "task_id");
