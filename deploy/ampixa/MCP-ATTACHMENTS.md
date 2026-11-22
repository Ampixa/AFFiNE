# MCP document attachments

`upload_attachment` stores a workspace blob and inserts an `affine:attachment`
block without replacing the document body. It is available only for read/write
MCP credentials when MCP writes are enabled. The authenticated user needs active
workspace access, blob-write permission, and edit permission on the target doc.

## Tool arguments

- `docId`: existing page document (not workspace metadata).
- `requestId`: caller-generated unique ID. Reuse it with **identical arguments and
  the same credential** when retrying an uncertain response.
- `fileName`: filename only, with a matching extension; no paths/control characters.
- `mimeType`: one of the types below.
- `contentBase64`: canonical base64, without whitespace or a data-URI prefix.
- `afterBlockId` (optional): insert after a reachable block in a page note. Without
  this, append to the last page note. Database rows and canvas-only notes are not
  insertion targets.
- `caption` (optional): up to 2,000 characters.

Returns `blobKey`, `blockId`, `downloadUrl`, `size`, `sha256`, and `alreadyUploaded`.
Verify the SHA-256 against the original file. Read-only credentials cannot call
this tool. It does not fetch arbitrary URLs or read paths from the server.

## Limits

| MIME type         | Extensions         |
| ----------------- | ------------------ |
| `application/pdf` | `.pdf`             |
| `image/png`       | `.png`             |
| `image/jpeg`      | `.jpg`, `.jpeg`    |
| `image/webp`      | `.webp`            |
| `text/plain`      | `.txt`             |
| `text/markdown`   | `.md`, `.markdown` |
| `text/csv`        | `.csv`             |

The default decoded limit is **10 MiB**. Set
`AFFINE_MCP_ATTACHMENT_MAX_BYTES` to an integer between 1 and 26,214,400 (25 MiB),
then restart. Invalid configuration fails startup rather than silently removing
limits. Workspace file-size and storage quotas still apply. Redis enforces
20 upload attempts per hour per credential; successful identical retries do not
consume another attempt. If the limiter is unavailable, uploads fail closed.

Binary types require matching signatures and basic container markers. Text must
be UTF-8 without binary control bytes or HTML/SVG/XML tags. Executables, archives,
HTML and SVG are not accepted, including a renamed executable with a PDF MIME.
This is format validation, not antivirus scanning or PDF content sanitization.

Base64 expands the payload by about one third. Only the authenticated MCP POST
route gets the larger JSON body limit; other APIs retain their current limits.
Compressed MCP request bodies are rejected. Configure the reverse proxy to
permit at least 14 MiB for the default file limit (34 MiB for a 25 MiB file limit),
scoped to the MCP endpoint. A lower proxy limit can reject a request before the
tool runs. Avoid putting file contents or bearer credentials in logs.

## Download access and compatibility

New keys use the reserved `mcp-attachment.` namespace, encoding the source doc ID
and an opaque, immutable upload-attempt hash. Every download requires both
workspace membership and read permission on that source document. Public sharing of that or any other doc
does not make these files public. Malformed keys in this namespace also fail
closed. These responses use `private, no-store`, never a storage redirect or a
signed public download URL. AFFiNE's existing attachment viewer/download controls
use the same authenticated blob endpoint.

The generic blob upload, multipart and delete APIs cannot modify these reserved
keys. Remove a native attachment block to remove it from a document. Blob
inventories filter these files by source-document read access. Workspace info and
email avatar rendering cannot reuse a protected attachment as a public avatar.

Copying the block into another document does **not** grant access to the file:
readers still need the original source document's permission. Upload a separate
attachment for a different audience. Permissions cannot revoke bytes a member
already downloaded or cached locally in AFFiNE's offline storage.

Existing blob keys keep their current behavior. This change does not migrate,
rename or retroactively protect historical attachments. Review legacy blob
sharing separately before distributing sensitive existing links.

## Failure handling and audit

Writes are Yjs deltas; existing text and concurrent browser edits are preserved.
Permissions are checked again after blob upload, before writing the block.
A bounded database transaction and workspace advisory lock serialize MCP uploads
and commit the blob's quota record together with the document delta. A rolled-back
save cannot charge the same file again on retry. Concurrent ordinary browser
uploads retain their existing quota behavior.

Pre-save failures attempt cleanup. Every attempt has its own immutable storage
key. An ambiguous commit retains its file to avoid deleting an attachment that
was saved; retry with the same request ID. A successful retry verifies the saved
file's size and SHA-256 before returning it. Physical files from interrupted
attempts can remain orphaned even when their quota record rolled back; these need
operator cleanup. This change does not introduce background orphan collection.

Successful new writes log `mcp.attachment.uploaded` with credential **ID** (not
secret), user, workspace, document, filename, MIME, size, SHA-256, block/key and
time. No contents or bearer tokens are logged. Preserve these logs under the
installation's existing retention policy.

## Local checks

Local regression checks covered real Yjs merging, upload failures, retry behavior,
access revocation, quota/rate failures, format and size validation, the JSON-RPC
HTTP path, download access/caching, generic blob API isolation and public-avatar
exclusions. Regression files are retained locally and excluded from this change.
Their results do not replace checking the committed tree against CI.

Before release, use a disposable local database and real MCP credential:
upload a valid 1 MiB PDF, verify its native attachment card and download in the
UI, compare hashes, retry the request, and test anonymous/non-member access.
Never use production documents as upload-test fixtures.
