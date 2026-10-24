# Document editing in Intelligence chat

Browser chat can propose creating, editing or renaming documents. Each change
requires the signed-in user to review a preview and click **Apply**.

## Use

1. Attach the documents you want to work on using the chat's context picker.
2. Open the model/preferences menu, then **Document editing · review before
   saving**. Turn on **Allow edits: document title** for each editable document.
   For a new document, enable **Allow new document previews**.
3. Ask for the change. The response contains the target document, original text
   and proposed text. No document is changed by generation alone.
4. Review the preview and choose **Apply** or **Cancel**. Use **Open document**
   to inspect the saved result. Existing document sync and history still apply.

Editing choices are local to the composer. They are not global AI preferences
or changes to sharing permissions. Changing chats/workspaces resets them;
removing a document removes it from future edit requests. Existing proposals
remain individually reviewable until cancelled or expired.

**Workspace All Docs** remains a search/read setting. It never authorizes
editing everything in a workspace. A document needs both explicit selection
for editing and the user's existing `Doc.Read` / `Doc.Update` permission.
Creating a document requires `Workspace.CreateDoc`. Permissions and conversation
ownership are checked again when applying a proposal.

## Scope and limits

- Text document edits, additions, creation and title changes; no deletion,
  sharing changes, database mutations or image insertion.
- Up to four explicitly selected writable documents; 32 KiB combined UTF-8
  source text, 32 KiB proposed body, and 1 MiB per document snapshot.
- Documents with unsupported blocks, canvas content or rich-text attributes
  that Markdown cannot preserve are refused. Their content is left intact;
  use the normal editor for those documents.
- Proposals expire after 15 minutes. A user can prepare at most 20 proposals
  within that window. The preview and its short-lived result are kept in the
  existing Redis cache. After expiry, use the document/history to establish the
  result; an old chat preview is not a durable execution receipt.
- The normal chat transcript retains the proposal's before/after text, just
  as it retains other tool results. Changing document permissions later does
  not erase text already present in an existing chat history.

The preview is plain text, not executable HTML. The Apply request sends only a
proposal ID and decision: it cannot substitute a new body, document or actor.
The server uses the exact stored proposal and a revision derived from the
snapshot timestamp and SHA-256. It refuses stale edits and serializes chat
applies targeting the same document. Normal concurrent browser edits still
use the existing CRDT merge behavior; this is not a workspace editing lock.

Apply flushes this client's local document edits first. A repeated Apply returns
the existing result while its receipt is available. A failed or interrupted
write is never automatically repeated: inspect the document before requesting
another preview. Failed source reads never produce replacement document text.

## Deployment and verification

Deploy frontend and backend together through the existing release process.
There are no database migrations, new services, additional AI keys or embedding
requirements. The feature uses the current chat model's tool-calling support.
`AFFINE_COPILOT_DOCUMENT_EDITING=false` disables proposal creation and application
server-side. The default is enabled, with all composer write choices off.

Focused automated checks cover permissions, selection boundaries, changed
revisions, cancellation, duplicate/ambiguous writes, expired proposals, failed
reads, unsupported formatting, request validation and the preview's Apply flow.
They use synthetic documents and do not send document content to a paid model.

After deploying, verify with a disposable document and the configured chat model:

1. Read-only chat answers without a write tool. All Docs alone remains read-only.
2. Enable one document, request a text change and verify it remains unchanged
   until Apply. Apply once, reload the document and inspect its history.
3. Cancel another proposal and verify no change. Try Apply twice and confirm
   there is only one change.
4. Edit the document manually after a preview, then Apply: the stale preview
   must be refused. Revoke editing access before applying another preview and
   confirm that it is refused too.
5. Test new-document creation and a viewer account separately. Include an image
   or highlighted passage in a source document and confirm a safe refusal.

Keep production acceptance separate from local automated validation. A model
may choose to answer in text instead of calling a tool; it must not claim that
an unapproved proposal was saved.
