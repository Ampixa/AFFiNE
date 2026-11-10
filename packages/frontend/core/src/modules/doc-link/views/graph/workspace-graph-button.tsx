import { Button, Modal } from '@affine/component';
import { WorkspaceDBService } from '@affine/core/modules/db';
import { DocsService } from '@affine/core/modules/doc';
import { DocsSearchService } from '@affine/core/modules/docs-search';
import { GuardService } from '@affine/core/modules/permissions';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { LiveData, useLiveData, useServices } from '@toeverything/infra';
import { useEffect, useMemo, useState } from 'react';
import { of } from 'rxjs';

import { DocumentGraph } from './document-graph';
import { folderGraph, type GraphEdge } from './model';
import { useReadableDocs } from './use-readable-docs';

export function WorkspaceGraphButton() {
  const {
    docsService,
    docsSearchService,
    guardService,
    workbenchService,
    workspaceDBService,
  } = useServices({
    DocsService,
    DocsSearchService,
    GuardService,
    WorkbenchService,
    WorkspaceDBService,
  });
  const [open, setOpen] = useState(false);
  const allIds = useLiveData(docsService.list.nonTrashDocsIds$);
  const ids = useMemo(() => allIds.slice(0, 200), [allIds]);
  const { docs, loading, error } = useReadableDocs(ids, open);
  const readableIds = useMemo(() => docs.map(doc => doc.id), [docs]);
  const folderRows = useLiveData(
    useMemo(
      () =>
        LiveData.from(
          open ? workspaceDBService.db.folders.find$() : of([]),
          []
        ),
      [open, workspaceDBService]
    )
  );
  const folders = useMemo(() => folderGraph(folderRows), [folderRows]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setEdges([]);
    setMessage('');
    if (!open || loading || error) return;
    const subscription = docsSearchService
      .watchRefsBySourceFrom(readableIds, 2000)
      .subscribe({
        next: refs =>
          setEdges(
            [...refs].flatMap(([source, targets]) =>
              targets.map(target => ({ source, target: target.docId }))
            )
          ),
        error: () =>
          setMessage('The local link index is unavailable. Close and retry.'),
      });
    return () => subscription.unsubscribe();
  }, [open, loading, error, readableIds, docsSearchService]);
  return (
    <>
      <Button variant="plain" onClick={() => setOpen(true)}>
        Graph view
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        contentOptions={{
          style: { maxWidth: 1100, width: 'calc(100vw - 48px)' },
        }}
      >
        <h2>Workspace graph</h2>
        {loading && <p role="status">Checking document access…</p>}
        {(error || message) && (
          <p role="alert">
            {message || 'Could not verify document access. Close and retry.'}
          </p>
        )}
        <DocumentGraph
          docs={error ? [] : [...folders.docs, ...docs]}
          edges={[...folders.edges, ...edges]}
          caption="Sidebar folders and local indexed links · first 200 documents, up to 2,000 reference blocks · missing connections may still be indexing or outside this view"
          onOpen={id => {
            void guardService
              .can('Doc_Read', id)
              .then(can => {
                if (!can) {
                  setMessage('This document is no longer accessible.');
                  return;
                }
                setOpen(false);
                workbenchService.workbench.openDoc(id);
              })
              .catch(() =>
                setMessage('Could not verify document access. Please retry.')
              );
          }}
        />
      </Modal>
    </>
  );
}
