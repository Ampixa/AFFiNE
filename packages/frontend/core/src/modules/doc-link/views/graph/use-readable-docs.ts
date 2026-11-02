import { DocsService } from '@affine/core/modules/doc';
import { GuardService } from '@affine/core/modules/permissions';
import { useServices } from '@toeverything/infra';
import { useEffect, useState } from 'react';
import { combineLatest, of, switchMap } from 'rxjs';

import type { GraphDoc } from './model';

const emptyDocs: GraphDoc[] = [];

/** Permission checks are sequential; titles are subscribed only after read access. */
export function useReadableDocs(ids: string[], open: boolean) {
  const { docsService, guardService } = useServices({
    DocsService,
    GuardService,
  });
  const [state, setState] = useState({
    ids,
    docs: [] as GraphDoc[],
    loading: true,
    error: false,
  });
  useEffect(() => {
    let cancelled = false;
    setState({ ids, docs: [], loading: true, error: false });
    if (!open) return;
    const subscription = (
      ids.length
        ? combineLatest(
            ids.map(id =>
              guardService.can$('Doc_Read', id).pipe(
                switchMap(can => {
                  if (can !== true) return of(null);
                  return docsService.list.doc$(id).pipe(
                    switchMap(record =>
                      record
                        ? combineLatest([record.title$, record.trash$]).pipe(
                            switchMap(([title, trash]) =>
                              of(
                                trash
                                  ? null
                                  : {
                                      id,
                                      title: title || 'Untitled',
                                      group: 'Documents',
                                    }
                              )
                            )
                          )
                        : of(null)
                    )
                  );
                })
              )
            )
          )
        : of([])
    ).subscribe({
      next: values =>
        setState(previous => ({
          ...previous,
          ids,
          docs: values.filter(
            (value): value is GraphDoc & { group: string } => value !== null
          ),
        })),
      error: () => setState({ ids, docs: [], loading: false, error: true }),
    });
    void (async () => {
      try {
        for (const id of ids) {
          if (cancelled) return;
          await guardService.can('Doc_Read', id);
        }
        if (!cancelled) setState(previous => ({ ...previous, loading: false }));
      } catch {
        if (!cancelled)
          setState({ ids, docs: [], loading: false, error: true });
      }
    })().catch(() => {
      if (!cancelled) setState({ ids, docs: [], loading: false, error: true });
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [ids, open, docsService, guardService]);
  return state.ids === ids && open
    ? state
    : { docs: emptyDocs, loading: true, error: false };
}
