// The namespace is also an access-control boundary. Never serve these keys via
// the workspace-wide public sharing fallback, including malformed keys.
export const MCP_ATTACHMENT_PREFIX = 'mcp-attachment.';

export function mcpAttachmentDocId(key: string): string | undefined {
  const match = /^mcp-attachment\.([A-Za-z0-9_-]+)\.[a-f0-9]{64}$/.exec(key);
  if (!match) return;
  const docId = Buffer.from(match[1], 'base64url').toString('utf8');
  if (
    !docId ||
    docId.length > 128 ||
    Buffer.from(docId).toString('base64url') !== match[1]
  )
    return;
  return docId;
}
