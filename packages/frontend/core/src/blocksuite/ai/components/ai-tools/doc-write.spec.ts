/** @vitest-environment happy-dom */
import { afterEach, expect, test, vi } from 'vitest';

import { DocWriteTool } from './doc-write';

const service = vi.hoisted(() => ({
  waitForSelectedSources: vi.fn(async () => {}),
  client: {
    decideDocumentEdit: vi.fn(
      async (_id: string, decision: string, _kind?: 'task') => ({
        status:
          decision === 'status'
            ? 'proposed'
            : decision === 'cancel'
              ? 'cancelled'
              : 'applied',
        docId: 'doc',
      })
    ),
  },
}));
vi.mock('../../runtime/request', () => ({
  getAIRequestService: () => service,
}));

// The repository setup stubs the custom-elements registry; use the real DOM here.
vi.unstubAllGlobals();
if (!customElements.get('test-doc-write-tool'))
  customElements.define('test-doc-write-tool', DocWriteTool);

async function mount(
  kind: 'document' | 'task' | 'task_create' | 'task_link_document' = 'document',
  expected: 'proposed' | 'applied' = 'proposed'
) {
  const element = document.createElement('test-doc-write-tool') as DocWriteTool;
  element.data = {
    type: 'tool-result',
    toolCallId: 'call',
    toolName:
      kind === 'document'
        ? 'doc_update'
        : kind === 'task'
          ? 'task_update'
          : kind,
    args: kind !== 'document' ? {} : { doc_id: 'doc' },
    result: {
      status: 'proposed',
      proposalId: 'proposal',
      operation: 'update',
      ...(kind !== 'document' ? {} : { docId: 'doc' }),
      title: kind !== 'document' ? 'Release task' : 'Roadmap',
      before: 'Old paragraph',
      after: '<script>unsafe()</script> New paragraph',
    },
  };
  document.body.append(element);
  await vi.waitFor(() => expect(element.decision).toBe(expected));
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('preview does not write; Apply flushes edits and saves once, Cancel never applies', async () => {
  const element = await mount();
  expect(service.client.decideDocumentEdit).toHaveBeenCalledTimes(1);
  expect(service.client.decideDocumentEdit).toHaveBeenCalledWith(
    'proposal',
    'status'
  );
  expect(element.textContent).toContain('Old paragraph');
  expect(element.textContent).toContain('<script>unsafe()</script>');
  expect(element.querySelector('script')).toBeNull();
  const apply = [...element.querySelectorAll('button')].find(
    button => button.textContent?.trim() === 'Apply'
  );
  apply?.click();
  await vi.waitFor(() => expect(element.decision).toBe('applied'));
  await element.updateComplete;
  expect(service.waitForSelectedSources).toHaveBeenCalledWith(['doc']);
  expect(
    service.waitForSelectedSources.mock.invocationCallOrder[0]
  ).toBeLessThan(service.client.decideDocumentEdit.mock.invocationCallOrder[1]);
  expect(apply?.disabled).toBe(true);
  expect(element.textContent).toContain('Saved to document.');

  const second = await mount();
  const cancel = [...second.querySelectorAll('button')].find(
    button => button.textContent?.trim() === 'Cancel'
  );
  cancel?.click();
  await vi.waitFor(() => expect(second.decision).toBe('cancelled'));
  expect(
    service.client.decideDocumentEdit.mock.calls.filter(
      call => call[1] === 'apply'
    )
  ).toHaveLength(1);
});

test('conflicts and network errors leave the preview unsaved and prevent blind retries', async () => {
  const element = await mount();
  service.client.decideDocumentEdit.mockRejectedValueOnce(
    new Error('Document changed. Request a new preview.')
  );
  [...element.querySelectorAll('button')]
    .find(button => button.textContent?.trim() === 'Apply')
    ?.click();
  await vi.waitFor(() => expect(element.decision).toBe('uncertain'));
  await element.updateComplete;
  expect(element.querySelector('[role=alert]')?.textContent).toContain(
    'Document changed'
  );
  expect(element.textContent).not.toContain('Saved to document.');
  expect(
    [...element.querySelectorAll('button')].find(
      button => button.textContent?.trim() === 'Apply'
    )?.disabled
  ).toBe(true);
});

test('task previews route status and Apply to task decisions without flushing a document', async () => {
  const element = await mount('task');
  expect(service.client.decideDocumentEdit).toHaveBeenCalledWith(
    'proposal',
    'status',
    'task'
  );
  expect(service.client.decideDocumentEdit).toHaveBeenCalledTimes(1);
  expect(element.textContent).toContain('Task change');
  const apply = [...element.querySelectorAll('button')].find(
    button => button.textContent?.trim() === 'Apply'
  );
  apply?.click();
  await vi.waitFor(() => expect(element.decision).toBe('applied'));
  await element.updateComplete;
  expect(service.client.decideDocumentEdit).toHaveBeenCalledWith(
    'proposal',
    'apply',
    'task'
  );
  expect(service.waitForSelectedSources).not.toHaveBeenCalled();
  expect(element.textContent).toContain('Saved to task.');
  expect(apply?.disabled).toBe(true);
});

test('task Cancel never applies and an ownership conflict disables further Apply', async () => {
  const cancelled = await mount('task');
  [...cancelled.querySelectorAll('button')]
    .find(button => button.textContent?.trim() === 'Cancel')
    ?.click();
  await vi.waitFor(() => expect(cancelled.decision).toBe('cancelled'));
  expect(service.client.decideDocumentEdit).toHaveBeenCalledWith(
    'proposal',
    'cancel',
    'task'
  );
  expect(
    service.client.decideDocumentEdit.mock.calls.filter(
      call => call[1] === 'apply'
    )
  ).toHaveLength(0);
  const changed = await mount('task');
  service.client.decideDocumentEdit.mockRejectedValueOnce(
    new Error('Task ownership changed. Request a new preview.')
  );
  [...changed.querySelectorAll('button')]
    .find(button => button.textContent?.trim() === 'Apply')
    ?.click();
  await vi.waitFor(() => expect(changed.decision).toBe('uncertain'));
  await changed.updateComplete;
  expect(changed.querySelector('[role=alert]')?.textContent).toContain(
    'ownership changed'
  );
  expect(
    [...changed.querySelectorAll('button')].find(
      button => button.textContent?.trim() === 'Apply'
    )?.disabled
  ).toBe(true);
  expect(service.waitForSelectedSources).not.toHaveBeenCalled();
});

for (const kind of ['task_create', 'task_link_document'] as const) {
  test(`${kind} uses task preview decisions, cancels safely and restores saved state`, async () => {
    const element = await mount(kind);
    expect(element.querySelector('script')).toBeNull();
    expect(element.textContent).toContain(
      kind === 'task_create' ? 'New task' : 'Link document to task'
    );
    expect(service.client.decideDocumentEdit).toHaveBeenCalledWith(
      'proposal',
      'status',
      'task'
    );
    const button = (name: string) =>
      [...element.querySelectorAll('button')].find(
        item => item.textContent?.trim() === name
      );
    button('Cancel')?.click();
    await vi.waitFor(() => expect(element.decision).toBe('cancelled'));
    expect(service.client.decideDocumentEdit).toHaveBeenCalledWith(
      'proposal',
      'cancel',
      'task'
    );
    const next = await mount(kind);
    [...next.querySelectorAll('button')]
      .find(item => item.textContent?.trim() === 'Apply')
      ?.click();
    await vi.waitFor(() => expect(next.decision).toBe('applied'));
    await next.updateComplete;
    expect(service.client.decideDocumentEdit).toHaveBeenCalledWith(
      'proposal',
      'apply',
      'task'
    );
    expect(service.waitForSelectedSources).not.toHaveBeenCalled();
    expect(next.textContent).toContain(
      kind === 'task_create' ? 'Task created.' : 'Document linked to task.'
    );
    expect(next.textContent).not.toContain('Open document');
    service.client.decideDocumentEdit.mockResolvedValueOnce({
      status: 'applied',
      docId: 'doc',
    });
    const restored = await mount(kind, 'applied');
    expect(
      [...restored.querySelectorAll('button')].find(
        item => item.textContent?.trim() === 'Apply'
      )?.disabled
    ).toBe(true);
    expect(restored.textContent).toContain(
      kind === 'task_create' ? 'Task created.' : 'Document linked to task.'
    );
  });
}

test('unlink previews accurately describe removal and its saved result', async () => {
  const element = await mount('task_link_document');
  if (element.data.type !== 'tool-result') throw new Error('Expected result');
  element.data = {
    ...element.data,
    result: {
      status: 'proposed',
      proposalId: 'proposal',
      operation: 'link',
      linked: false,
      title: 'Release task',
      after: '{"docId":"doc","linked":false}',
    },
  };
  await element.updateComplete;
  expect(element.textContent).toContain('Remove document link');
  expect(element.textContent).not.toContain('Link document to task');
  [...element.querySelectorAll('button')]
    .find(button => button.textContent?.trim() === 'Apply')
    ?.click();
  await vi.waitFor(() => expect(element.decision).toBe('applied'));
  await element.updateComplete;
  expect(element.textContent).toContain('Document unlinked from task.');
  expect(element.textContent).not.toContain('Document linked to task.');
});
