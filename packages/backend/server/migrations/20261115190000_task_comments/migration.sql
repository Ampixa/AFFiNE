BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE "task_comments" (
 "id" VARCHAR NOT NULL PRIMARY KEY, "task_id" VARCHAR NOT NULL,
 "actor_id" VARCHAR NOT NULL, "body" TEXT NOT NULL,
 "edited" BOOLEAN NOT NULL DEFAULT false,
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "workspace_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "task_comments_task_id_created_at_id_idx" ON "task_comments"("task_id", "created_at", "id");
COMMIT;
