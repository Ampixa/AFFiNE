import { Button, Modal } from '@affine/component';
import { GuardService } from '@affine/core/modules/permissions';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { useServices } from '@toeverything/infra';
import { useMemo, useState } from 'react';

import type { Backlink, Link } from '../../index';
import { DocumentGraph } from './document-graph';
import type { GraphEdge } from './model';
import { useReadableDocs } from './use-readable-docs';

/** Reuses the document panel's existing indexed links; does not crawl documents. */
export function ConnectionsButton({
  docId,
  links,
  backlinks,
  onNavigate,
}: {
  docId: string;
  links: Link[];
  backlinks: Backlink[];
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { guardService, workbenchService } = useServices({
    GuardService,
    WorkbenchService,
  });
  const candidates = useMemo(
    () =>
      [
        ...new Set([
          docId,
          ...links.map(l => l.docId),
          ...backlinks.map(l => l.docId),
        ]),
      ].slice(0, 50),
    [docId, links, backlinks]
  );
  const readable = useReadableDocs(candidates, open);
  const docs = readable.docs.some(doc => doc.id === docId) ? readable.docs : [];
  const edges: GraphEdge[] = [
    ...links.map(link => ({ source: docId, target: link.docId })),
    ...backlinks.map(link => ({ source: link.docId, target: docId })),
  ];
  return (
    <>
      <Button variant="plain" onClick={() => setOpen(true)}>
        Explore connections
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        contentOptions={{
          style: { maxWidth: 1100, width: 'calc(100vw - 48px)' },
        }}
      >
        <h2>Document connections</h2>
        {readable.loading && <p role="status">Checking document access…</p>}
        {(error || readable.error) && (
          <p role="alert">
            {error || 'Could not verify document access. Close and retry.'}
          </p>
        )}
        <DocumentGraph
          docs={docs}
          edges={edges}
          initialId={docId}
          onOpen={id => {
            void guardService
              .can('Doc_Read', id)
              .then(can => {
                if (can) {
                  setOpen(false);
                  onNavigate();
                  workbenchService.workbench.openDoc(id);
                } else {
                  setError('This document is no longer accessible.');
                }
              })
              .catch(() =>
                setError('Could not verify document access. Please retry.')
              );
          }}
          caption="Indexed links around this document · up to 50 accessible documents · not a complete workspace map"
        />
      </Modal>
    </>
  );
}
