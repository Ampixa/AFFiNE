-- Additive: ordinary tasks, document contents and existing links remain intact.
CREATE UNIQUE INDEX "workspace_tasks_workspace_id_id_key" ON "workspace_tasks"("workspace_id", "id");
-- Defer the parent reference until commit so workspace cascades may delete
-- parents and their planning rows in any order. Surviving orphan links still fail.
CREATE TABLE "task_planning" (
  "task_id" VARCHAR NOT NULL,
  "workspace_id" VARCHAR NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'task',
  "parent_id" VARCHAR,
  "estimate" TEXT NOT NULL DEFAULT '',
  "done_when" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "task_planning_pkey" PRIMARY KEY ("task_id"),
  CONSTRAINT "task_planning_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "workspace_tasks"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_planning_workspace_id_parent_id_fkey" FOREIGN KEY ("workspace_id", "parent_id") REFERENCES "workspace_tasks"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "task_planning_no_self" CHECK ("task_id" <> "parent_id"),
  CONSTRAINT "task_planning_kind" CHECK ("kind" IN ('epic', 'task', 'subtask'))
);
CREATE UNIQUE INDEX "task_planning_workspace_id_task_id_key" ON "task_planning"("workspace_id", "task_id");
CREATE INDEX "task_planning_workspace_id_parent_id_task_id_idx" ON "task_planning"("workspace_id", "parent_id", "task_id");
CREATE TABLE "task_dependencies" (
  "workspace_id" VARCHAR NOT NULL,
  "task_id" VARCHAR NOT NULL,
  "blocker_id" VARCHAR NOT NULL,
  CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("task_id", "blocker_id"),
  CONSTRAINT "task_dependencies_workspace_id_task_id_fkey" FOREIGN KEY ("workspace_id", "task_id") REFERENCES "workspace_tasks"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_dependencies_workspace_id_blocker_id_fkey" FOREIGN KEY ("workspace_id", "blocker_id") REFERENCES "workspace_tasks"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_dependencies_no_self" CHECK ("task_id" <> "blocker_id")
);
CREATE INDEX "task_dependencies_blocker_id_task_id_idx" ON "task_dependencies"("blocker_id", "task_id");
