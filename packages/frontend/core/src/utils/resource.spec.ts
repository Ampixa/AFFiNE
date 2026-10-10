import * as fileType from 'file-type';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { resourceUrlToBlob } from './resource';

vi.mock('file-type', { spy: true });

const RESOURCE_URL = 'https://example.com/attachment';
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII='
  ),
  char => char.charCodeAt(0)
);

function respond(body: BodyInit | null, contentType?: string, status = 200) {
  const response = new Response(body, {
    status,
    headers: contentType ? { 'Content-Type': contentType } : {},
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resourceUrlToBlob', () => {
  test.each([
    ['text/plain', 'नमस्कार, यो सुरक्षित राखिएको नोट हो।'],
    ['text/csv', 'name,amount\nExample,150\n'],
    ['application/json', '{"name":"Example","enabled":true}'],
    [
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    ],
  ])(
    'preserves bytes and response MIME for %s without a binary signature',
    async (mime, body) => {
      respond(new TextEncoder().encode(body), mime);

      const blob = await resourceUrlToBlob(RESOURCE_URL);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe(mime);
      expect(await blob.text()).toBe(body);
    }
  );

  test('downloads unknown binary data without Content-Type', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
    respond(bytes);

    const blob = await resourceUrlToBlob(RESOURCE_URL);

    expect(blob.type).toBe('application/octet-stream');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  test('preserves a valid empty file', async () => {
    respond(new Uint8Array(), 'text/plain');

    const blob = await resourceUrlToBlob(RESOURCE_URL);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(0);
    expect(blob.type).toBe('text/plain');
  });

  test('still detects binary MIME when the server sends a generic type', async () => {
    respond(png, 'application/octet-stream');

    const blob = await resourceUrlToBlob(RESOURCE_URL);

    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
  });

  test('preserves data if optional file-type inspection cannot parse it', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    respond(bytes, 'application/octet-stream');
    vi.mocked(fileType.fileTypeFromBuffer).mockRejectedValueOnce(
      new Error('Cannot inspect resource')
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const blob = await resourceUrlToBlob(RESOURCE_URL);

    expect(blob.type).toBe('application/octet-stream');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  test.each([403, 404, 500])(
    'rejects HTTP %i before reading or downloading the body',
    async status => {
      const response = respond(png, 'image/png', status);
      const read = vi.spyOn(response, 'arrayBuffer');

      await expect(resourceUrlToBlob(RESOURCE_URL)).rejects.toThrow(
        `HTTP ${status}`
      );
      expect(read).not.toHaveBeenCalled();
    }
  );

  test('propagates network errors to the caller', async () => {
    const error = new TypeError('Network unavailable');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));

    await expect(resourceUrlToBlob(RESOURCE_URL)).rejects.toBe(error);
  });

  test('propagates body-read failures instead of returning an empty file', async () => {
    const response = respond(png, 'image/png');
    const error = new Error('Body stream failed');
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(error);

    await expect(resourceUrlToBlob(RESOURCE_URL)).rejects.toBe(error);
  });
});
