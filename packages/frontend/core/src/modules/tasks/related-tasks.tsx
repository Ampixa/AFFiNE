import { Button, Modal } from '@affine/component';
import { GuardService } from '@affine/core/modules/permissions';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { useLiveData, useServices } from '@toeverything/infra';
import { cssVarV2 } from '@toeverything/theme/v2';
import { useEffect, useState } from 'react';

import { useTasks } from './use-tasks';

/** Uses the same native task documents as the workspace Tasks view. */
export function RelatedTasksButton({
  docId,
  onNavigate,
}: {
  docId: string;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="plain" onClick={() => setOpen(true)}>
        Related tasks
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        contentOptions={{
          style: { maxWidth: 640, width: 'calc(100vw - 48px)' },
        }}
      >
        {open ? (
          <RelatedTasksPanel
            key={docId}
            docId={docId}
            onNavigate={() => {
              setOpen(false);
              onNavigate();
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}

function RelatedTasksPanel({
  docId,
  onNavigate,
}: {
  docId: string;
  onNavigate: () => void;
}) {
  const { guardService, workbenchService } = useServices({
    GuardService,
    WorkbenchService,
  });
  const cloudReadAccess = useLiveData(guardService.can$('Doc_Read', docId));
  const cloudUpdateAccess = useLiveData(guardService.can$('Doc_Update', docId));
  const {
    tasks,
    loading,
    error,
    canCreate,
    createTask,
    linkDocument,
    isLocal,
    readableDocs,
  } = useTasks();
  const canReadSource = isLocal
    ? readableDocs.some(doc => doc.id === docId)
    : cloudReadAccess;
  const canLinkSource = isLocal ? canReadSource : cloudUpdateAccess;
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (isLocal) return;
    let active = true;
    void Promise.all([
      guardService.can('Doc_Read', docId),
      guardService.can('Doc_Update', docId),
    ]).catch(() => {
      if (active)
        setActionError(
          'Could not verify document access. Please reopen this panel.'
        );
    });
    return () => {
      active = false;
    };
  }, [docId, guardService, isLocal]);

  const related =
    canReadSource === true
      ? tasks.filter(
          task => !task.archived && task.linkedDocIds.includes(docId)
        )
      : [];

  const openTask = async (id: string) => {
    setActionError(null);
    try {
      if (
        !isLocal &&
        (!(await guardService.can('Doc_Read', docId)) ||
          !(await guardService.can('Doc_Read', id)))
      ) {
        throw new Error('This document or task is no longer accessible.');
      }
      onNavigate();
      workbenchService.workbench.openDoc(id);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : 'Could not open this task.'
      );
    }
  };

  return (
    <section style={{ display: 'grid', gap: 16 }} aria-label="Related tasks">
      <div>
        <h2 style={{ margin: '0 0 8px', fontSize: 20 }}>Related tasks</h2>
        <p style={{ margin: 0, color: cssVarV2('text/secondary') }}>
          Work linked to this document. Each task opens in the normal editor.
        </p>
      </div>
      {actionError || error ? <p role="alert">{actionError || error}</p> : null}
      {loading || canReadSource === undefined ? (
        <p role="status">Checking tasks and document access…</p>
      ) : canReadSource !== true ? (
        <p>This document is not accessible.</p>
      ) : (
        <>
          {related.length ? (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'grid',
                gap: 8,
              }}
            >
              {related.map(task => (
                <li key={task.id}>
                  <Button
                    variant="plain"
                    style={{
                      width: '100%',
                      justifyContent: 'space-between',
                      textAlign: 'left',
                      height: 'auto',
                      padding: '10px 12px',
                    }}
                    onClick={() => void openTask(task.id)}
                  >
                    <span style={{ overflowWrap: 'anywhere' }}>
                      {task.title || 'Untitled task'}
                    </span>
                    <span
                      style={{
                        color: cssVarV2('text/secondary'),
                        fontSize: 12,
                        marginLeft: 12,
                        textTransform: 'capitalize',
                      }}
                    >
                      {task.status}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: cssVarV2('text/secondary') }}>
              No accessible tasks are linked here yet.
            </p>
          )}
          <form
            style={{ display: 'grid', gap: 8 }}
            onSubmit={event => {
              event.preventDefault();
              if (
                pending ||
                !canCreate ||
                canReadSource !== true ||
                canLinkSource !== true ||
                !title.trim()
              )
                return;
              setPending(true);
              setActionError(null);
              const operation = createdTaskId
                ? linkDocument(createdTaskId, docId).then(() => createdTaskId)
                : createTask({ title: title.trim(), linkedDocIds: [docId] });
              void operation
                .then(async id => {
                  setCreatedTaskId(null);
                  setTitle('');
                  await openTask(id);
                })
                .catch(cause => {
                  if (
                    cause &&
                    typeof cause === 'object' &&
                    'createdTaskId' in cause &&
                    typeof cause.createdTaskId === 'string'
                  ) {
                    setCreatedTaskId(cause.createdTaskId);
                  }
                  setActionError(
                    cause instanceof Error
                      ? cause.message
                      : 'Could not create the task.'
                  );
                })
                .finally(() => setPending(false));
            }}
          >
            <label htmlFor="related-task-title">
              Create a task for this document
            </label>
            <input
              id="related-task-title"
              value={title}
              onChange={event => setTitle(event.target.value)}
              maxLength={200}
              required
              disabled={
                pending ||
                !canCreate ||
                canLinkSource !== true ||
                !!createdTaskId
              }
              placeholder="What needs to happen?"
              style={{
                font: 'inherit',
                padding: '9px 12px',
                borderRadius: 8,
                border: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
                background: cssVarV2('layer/background/primary'),
                color: cssVarV2('text/primary'),
              }}
            />
            <Button
              disabled={
                pending || !canCreate || canLinkSource !== true || !title.trim()
              }
            >
              {pending
                ? 'Saving…'
                : createdTaskId
                  ? 'Retry linking existing task'
                  : 'Create linked task'}
            </Button>
            {createdTaskId ? (
              <Button
                variant="plain"
                onClick={event => {
                  event.preventDefault();
                  void openTask(createdTaskId).catch(() =>
                    setActionError('Could not open the created task.')
                  );
                }}
              >
                Open created task
              </Button>
            ) : null}
            {canLinkSource !== true ? (
              <small>
                Creating a linked task needs edit access to this context
                document. You can still read the tasks listed above.
              </small>
            ) : null}
            {!canCreate ? (
              <small>You do not currently have access to create tasks.</small>
            ) : null}
          </form>
        </>
      )}
    </section>
  );
}
