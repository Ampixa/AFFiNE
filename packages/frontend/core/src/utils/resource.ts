import { fileTypeFromBuffer } from 'file-type';

export async function resourceUrlToBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch resource (HTTP ${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  let mime = response.headers.get('content-type') || 'application/octet-stream';

  // Detection corrects generic server MIME types, but text and unknown formats
  // are still valid downloads even when they have no recognized binary signature.
  try {
    const type = await fileTypeFromBuffer(buffer);
    mime = type?.mime ?? mime;
  } catch (error) {
    console.warn(
      'Could not detect resource type; keeping response MIME.',
      error
    );
  }

  return new Blob([buffer], { type: mime });
}

export async function downloadBlob(blob: Blob, filename: string) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

export function downloadFile(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.target = '_blank';
  a.click();
}

export async function downloadResourceWithUrl(url: string, filename: string) {
  // given input url may not have correct mime type
  const blob = await resourceUrlToBlob(url);
  await downloadBlob(blob, filename);
}
