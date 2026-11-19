// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../views/graph/use-graph-motion', () => ({
  useGraphMotion: (seed: Map<string, unknown>) => ({
    positions: seed,
    paused: true,
    reduced: false,
    setPaused: vi.fn(),
    move: vi.fn(),
    release: vi.fn(),
  }),
}));
import { DocumentGraph } from '../views/graph/document-graph';
import { folderGraph } from '../views/graph/model';

afterEach(cleanup);

test('folders remain explorable beside hubs and never navigate to fake doc IDs', () => {
  const folders = folderGraph([
    { id: 'funding', type: 'folder', data: 'Funding' },
    { id: 'link', parentId: 'funding', type: 'doc', data: 'plan' },
  ]);
  const open = vi.fn();
  render(
    <DocumentGraph
      docs={[
        ...folders.docs,
        { id: 'hub', title: 'Project hub' },
        { id: 'plan', title: 'Plan' },
      ]}
      edges={folders.edges}
      onOpen={open}
    />
  );
  expect(
    screen
      .getByRole('button', { name: 'Hubs and folders' })
      .getAttribute('aria-pressed')
  ).toBe('true');
  const folder = screen.getByRole('button', { name: 'Select Funding' });
  fireEvent.click(folder);
  expect(screen.queryByRole('button', { name: /Open document/ })).toBeNull();
  fireEvent.keyDown(folder, { key: 'Enter' });
  fireEvent.doubleClick(folder);
  expect(screen.getByRole('button', { name: 'Select Plan' })).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Select Plan' }));
  fireEvent.click(screen.getByRole('button', { name: /Open document/ }));
  expect(open).toHaveBeenCalledExactlyOnceWith('plan');
});

test('revoked documents and their links disappear from the rendered graph', () => {
  const docs = [
    { id: 'folder:f', kind: 'folder' as const, title: 'Folder' },
    { id: 'private', title: 'Private title' },
  ];
  const edges = [{ source: 'folder:f', target: 'private' }];
  const { rerender } = render(
    <DocumentGraph docs={docs} edges={edges} initialId="private" />
  );
  expect(
    screen.getByRole('button', { name: 'Select Private title' })
  ).toBeTruthy();
  rerender(
    <DocumentGraph docs={[docs[0]]} edges={edges} initialId="private" />
  );
  expect(screen.queryByText('Private title')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Select Private title' })
  ).toBeNull();
});
