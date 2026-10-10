/**
 * @vitest-environment happy-dom
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  blobs: [] as { key: string; size: number }[],
  deleteBlob: vi.fn(),
  revalidate: vi.fn(),
  openConfirmModal: vi.fn(),
  notifyError: vi.fn(),
  fromAny: vi.fn((error: unknown) => error),
}));

vi.mock('@affine/component', () => ({
  Button: ({
    children,
    loading,
    prefix: _prefix,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    prefix?: ReactNode;
    variant?: string;
  }) => (
    <button {...props} aria-busy={loading}>
      {children}
    </button>
  ),
  Checkbox: ({ checked }: { checked: boolean }) => (
    <input type="checkbox" checked={checked} readOnly />
  ),
  Loading: () => <span>Loading</span>,
  notify: { error: mocks.notifyError },
  templateToString: () => '',
  useConfirmModal: () => ({ openConfirmModal: mocks.openConfirmModal }),
  useDisposable: () => ({ data: null, loading: false, error: null }),
}));

vi.mock('@affine/component/setting-components', () => ({
  Pagination: ({
    pageNum,
    totalCount,
    countPerPage,
    onPageChange,
  }: {
    pageNum: number;
    totalCount: number;
    countPerPage: number;
    onPageChange: (skip: number, page: number) => void;
  }) => (
    <nav aria-label="File pages">
      {Array.from(
        { length: Math.ceil(totalCount / countPerPage) },
        (_, page) => (
          <button
            key={page}
            aria-current={pageNum === page ? 'page' : undefined}
            onClick={() => onPageChange(page * countPerPage, page)}
          >
            Page {page + 1}
          </button>
        )
      )}
    </nav>
  ),
}));

vi.mock('@affine/core/modules/blob-management/services', () => ({
  BlobManagementService: class {},
}));
vi.mock('@toeverything/infra', () => {
  const unusedBlobs = {
    unusedBlobs$: 'blobs',
    isLoading$: 'loading',
    deleteBlob: mocks.deleteBlob,
    revalidate: mocks.revalidate,
  };
  return {
    useService: () => ({ unusedBlobs }),
    useLiveData: (value: string) => (value === 'blobs' ? mocks.blobs : false),
  };
});
vi.mock('@affine/error', () => ({
  UserFriendlyError: { fromAny: mocks.fromAny },
}));
vi.mock('@affine/i18n', () => ({
  useI18n: () =>
    new Proxy({}, { get: (_, key) => () => String(key).split('.').at(-1) }),
}));
vi.mock('@affine/track', () => ({
  default: {
    $: { settingsPanel: { workspace: { deleteUnusedBlob: vi.fn() } } },
  },
}));
vi.mock('@blocksuite/affine/components/icons', () => ({
  getAttachmentFileIcon: () => '',
}));
vi.mock('@blocksuite/icons/rc', () => ({ DeleteIcon: () => null }));
vi.mock('./style.css', () => ({
  empty: '',
  blobPreviewContainer: '',
  blobPreview: '',
  blobPreviewFooter: '',
  blobPreviewName: '',
  blobPreviewInfo: '',
  blobCard: '',
  blobGridItemCheckbox: '',
  blobManagementControls: '',
  blobManagementName: '',
  spacer: '',
  blobManagementNameInactive: '',
  blobManagementContainer: '',
  blobPreviewGrid: '',
}));

import { BlobManagementPanel } from './blob-management';

function setBlobs(count: number) {
  mocks.blobs = Array.from({ length: count }, (_, index) => ({
    key: `file-${index + 1}`,
    size: 1024,
  }));
}

function selectFile(key: string) {
  fireEvent.click(screen.getByText(key));
}

function requestDeletion() {
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  return mocks.openConfirmModal.mock.lastCall![0]
    .onConfirm as () => Promise<void>;
}

async function confirmDeletion() {
  const confirm = requestDeletion();
  await act(confirm);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteBlob.mockReset().mockResolvedValue(undefined);
  setBlobs(3);
});

afterEach(cleanup);

describe('unused file cleanup', () => {
  test('requires confirmation and deletes only the selected file', async () => {
    render(<BlobManagementPanel />);
    selectFile('file-2');
    const confirm = requestDeletion();

    expect(mocks.deleteBlob).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('blob-preview-card')).toHaveLength(3);
    await act(confirm);

    expect(mocks.deleteBlob).toHaveBeenCalledExactlyOnceWith('file-2', true);
    expect(screen.queryByText('file-2')).toBeNull();
    expect(screen.getByText('file-1')).toBeTruthy();
    expect(screen.getByText('file-3')).toBeTruthy();
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });

  test('shows a failed deletion and allows the same file to be retried', async () => {
    const error = new Error('Storage service unavailable');
    mocks.deleteBlob.mockRejectedValueOnce(error);
    render(<BlobManagementPanel />);
    selectFile('file-1');
    await confirmDeletion();

    expect(mocks.fromAny).toHaveBeenCalledWith(error);
    expect(mocks.notifyError).toHaveBeenCalledWith({ error });
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Delete',
    });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(screen.getByText('file-1')).toBeTruthy();

    await confirmDeletion();
    expect(mocks.deleteBlob).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('file-1')).toBeNull();
  });

  test('keeps failed and unattempted files after a partial deletion', async () => {
    mocks.deleteBlob
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Connection lost'));
    render(<BlobManagementPanel />);
    selectFile('file-1');
    selectFile('file-2');
    selectFile('file-3');
    await confirmDeletion();

    expect(mocks.deleteBlob.mock.calls).toEqual([
      ['file-1', true],
      ['file-2', true],
    ]);
    expect(screen.queryByText('file-1')).toBeNull();
    expect(screen.getByText('file-2')).toBeTruthy();
    expect(screen.getByText('file-3')).toBeTruthy();
    expect(screen.getByText('2 selected')).toBeTruthy();

    await confirmDeletion();
    expect(mocks.deleteBlob.mock.calls.slice(2)).toEqual([
      ['file-2', true],
      ['file-3', true],
    ]);
    expect(screen.getByText('empty')).toBeTruthy();
  });

  test('disables deletion while the storage request is pending', async () => {
    let resolve!: () => void;
    mocks.deleteBlob.mockReturnValueOnce(
      new Promise<void>(done => (resolve = done))
    );
    render(<BlobManagementPanel />);
    selectFile('file-1');
    const confirm = requestDeletion();
    let pending!: Promise<void>;
    act(() => {
      pending = confirm();
    });

    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Delete',
    });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      resolve();
      await pending;
    });
    expect(screen.queryByText('file-1')).toBeNull();
  });

  test('returns to the remaining files when deleting the only file on page two', async () => {
    setBlobs(10);
    render(<BlobManagementPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    selectFile('file-10');
    await confirmDeletion();

    expect(screen.getAllByTestId('blob-preview-card')).toHaveLength(9);
    expect(screen.getByText('file-1')).toBeTruthy();
    expect(screen.getByText('file-9')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  test('moves back one page when deleting the last of three pages', async () => {
    setBlobs(19);
    render(<BlobManagementPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    selectFile('file-19');
    await confirmDeletion();

    expect(screen.getAllByTestId('blob-preview-card')).toHaveLength(9);
    expect(screen.getByText('file-10')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Page 2' })
        .getAttribute('aria-current')
    ).toBe('page');
  });

  test('stays on a page that still has files after deletion', async () => {
    setBlobs(11);
    render(<BlobManagementPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    selectFile('file-10');
    await confirmDeletion();

    expect(screen.getAllByTestId('blob-preview-card')).toHaveLength(1);
    expect(screen.getByText('file-11')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Page 2' })
        .getAttribute('aria-current')
    ).toBe('page');
  });

  test('clamps the page after revalidation without jumping back when the list grows', () => {
    setBlobs(19);
    const { rerender } = render(<BlobManagementPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));

    setBlobs(1);
    rerender(<BlobManagementPanel />);
    expect(screen.getByText('file-1')).toBeTruthy();

    setBlobs(19);
    rerender(<BlobManagementPanel />);
    expect(screen.getByText('file-1')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Page 1' })
        .getAttribute('aria-current')
    ).toBe('page');
  });
});
