import z from 'zod/v3';

export class AttachmentUploadError extends Error {}
export const ATTACHMENT_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function attachmentSizeLimit(
  value = process.env.AFFINE_MCP_ATTACHMENT_MAX_BYTES
) {
  if (value === undefined) return 10 * 1024 * 1024;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES)
    throw new Error(
      'AFFINE_MCP_ATTACHMENT_MAX_BYTES must be between 1 and 26214400 bytes.'
    );
  return size;
}

export function attachmentInputSchema(limit: number) {
  return z
    .object({
      docId: z.string().min(1).max(128),
      requestId: z.string().min(1).max(128),
      fileName: z
        .string()
        .min(1)
        .max(200)
        .refine(
          // oxlint-disable-next-line no-control-regex
          v => !/[\\/\x00-\x1f\x7f]/.test(v) && v.trim() === v,
          'Use a filename without a path or control characters.'
        ),
      mimeType: z.enum(ATTACHMENT_MIMES),
      contentBase64: z
        .string()
        .min(4)
        .max(4 * Math.ceil(limit / 3)),
      afterBlockId: z.string().min(1).max(128).optional(),
      caption: z.string().max(2000).optional(),
    })
    .strict();
}
export type AttachmentInput = z.infer<ReturnType<typeof attachmentInputSchema>>;

export function decodeAttachment(input: AttachmentInput, limit: number) {
  const encoded = input.contentBase64;
  if (encoded.length > 4 * Math.ceil(limit / 3))
    throw new AttachmentUploadError(`FILE_TOO_LARGE: Maximum ${limit} bytes.`);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new AttachmentUploadError(
      'INVALID_BASE64: Send canonical base64 without a data URI or whitespace.'
    );
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > limit)
    throw new AttachmentUploadError(
      `FILE_TOO_LARGE: Send 1 to ${limit} bytes.`
    );
  if (bytes.toString('base64') !== encoded)
    throw new AttachmentUploadError('INVALID_BASE64: Noncanonical base64.');
  const extensions: Record<string, string[]> = {
    'application/pdf': ['pdf'],
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/webp': ['webp'],
    'text/plain': ['txt'],
    'text/markdown': ['md', 'markdown'],
    'text/csv': ['csv'],
  };
  if (
    !extensions[input.mimeType]?.includes(
      (input.fileName.split('.').pop() ?? '').toLowerCase()
    )
  )
    throw new AttachmentUploadError(
      'FILE_TYPE_MISMATCH: Filename extension must match mimeType.'
    );
  let valid = false;
  switch (input.mimeType) {
    case 'application/pdf':
      valid =
        /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(
          bytes.subarray(0, 16).toString('ascii')
        ) && /%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'));
      break;
    case 'image/png':
      valid =
        bytes.length >= 45 &&
        bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
        bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
        bytes
          .subarray(-12)
          .equals(Buffer.from('0000000049454e44ae426082', 'hex'));
      break;
    case 'image/jpeg':
      valid =
        bytes.length >= 4 &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255 &&
        bytes[bytes.length - 2] === 255 &&
        bytes[bytes.length - 1] === 217;
      break;
    case 'image/webp':
      valid =
        bytes.length >= 20 &&
        bytes.subarray(0, 4).toString() === 'RIFF' &&
        bytes.readUInt32LE(4) === bytes.length - 8 &&
        bytes.subarray(8, 12).toString() === 'WEBP' &&
        ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString());
      break;
    default:
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        // Text has no magic number. Require UTF-8, reject binary/control bytes,
        // executable/archive signatures, and active HTML/SVG/XML markup.
        valid =
          // Reject binary and control bytes in text-only MIME types.
          // oxlint-disable-next-line no-control-regex
          !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) &&
          !/^(?:MZ|#!|%PDF-|PK)/.test(text) &&
          !/<(?:!doctype|\?xml|\/?[a-z][\w:-]*(?:\s|\/?>))/i.test(text);
      } catch {
        valid = false;
      }
  }
  if (!valid)
    throw new AttachmentUploadError(
      'FILE_TYPE_MISMATCH: File bytes do not match an allowed type. Executables, archives, HTML and SVG are not accepted.'
    );
  return bytes;
}
