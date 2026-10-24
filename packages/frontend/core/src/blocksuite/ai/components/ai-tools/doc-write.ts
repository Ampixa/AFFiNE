import type { PeekViewService } from '@affine/core/modules/peek-view';
import { WithDisposable } from '@blocksuite/global/lit';
import { PageIcon, PenIcon } from '@blocksuite/icons/lit';
import { ShadowlessElement } from '@blocksuite/std';
import type { Signal } from '@preact/signals-core';
import { css, html, nothing, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';

import { getAIRequestService } from '../../runtime/request';
import type { DocDisplayConfig } from '../ai-chat-chips';
import type { ToolError } from './type';

type DocWriteToolName = 'doc_create' | 'doc_update' | 'doc_update_meta';

type DocWriteToolArgs = {
  doc_id?: string;
  title?: string;
  content?: string;
};

interface DocWriteToolCall {
  type: 'tool-call';
  toolCallId: string;
  toolName: DocWriteToolName;
  args: DocWriteToolArgs;
}

interface DocWriteToolResult {
  type: 'tool-result';
  toolCallId: string;
  toolName: DocWriteToolName;
  args: DocWriteToolArgs;
  result:
    | {
        success?: boolean;
        status?: 'proposed';
        proposalId?: string;
        operation?: 'create' | 'update' | 'rename';
        title?: string;
        before?: string;
        after?: string;
        expiresAt?: number;
        docId?: string;
        message?: string;
      }
    | ToolError
    | null;
}

const isToolError = (result: unknown): result is ToolError =>
  !!result &&
  typeof result === 'object' &&
  'type' in result &&
  (result as ToolError).type === 'error';

export class DocWriteTool extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    .document-edit-preview {
      border: 1px solid var(--affine-border-color);
      border-radius: 8px;
      padding: 12px;
      margin: 8px 0;
    }
    .document-edit-preview pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 260px;
      overflow: auto;
      font: inherit;
      background: var(--affine-background-secondary-color);
      padding: 8px;
    }
    .document-edit-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .document-edit-actions button {
      padding: 6px 12px;
      border: 1px solid var(--affine-border-color);
      border-radius: 6px;
      background: var(--affine-background-primary-color);
      color: var(--affine-text-primary-color);
      cursor: pointer;
    }
    .document-edit-actions button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .document-edit-preview [role='alert'] {
      color: var(--affine-error-color);
    }
  `;

  @state()
  accessor decision:
    | 'checking'
    | 'proposed'
    | 'applied'
    | 'cancelled'
    | 'uncertain' = 'checking';

  @state()
  accessor saving = false;

  @state()
  accessor actionError = '';

  @state()
  accessor savedDocId: string | undefined;

  private checkedProposal: string | undefined;

  protected override updated(_changed: PropertyValues) {
    const proposal = this.proposal;
    if (proposal && this.checkedProposal !== proposal.proposalId) {
      this.checkedProposal = proposal.proposalId;
      this.decide('status').catch(console.error);
    }
  }

  private get proposal() {
    const result = this.data?.type === 'tool-result' ? this.data.result : null;
    return result &&
      !isToolError(result) &&
      result.status === 'proposed' &&
      result.proposalId
      ? result
      : undefined;
  }

  private async decide(action: 'status' | 'apply' | 'cancel') {
    const proposal = this.proposal;
    if (!proposal?.proposalId || this.saving) return;
    const id = proposal.proposalId;
    this.saving = true;
    this.actionError = '';
    try {
      const service = getAIRequestService();
      // Flush this client's human edits before the server checks the revision.
      if (action === 'apply' && proposal.docId)
        await service.waitForSelectedSources([proposal.docId]);
      const result = await service.client.decideDocumentEdit(id, action);
      if (this.proposal?.proposalId !== id) return;
      this.decision = result.status;
      this.savedDocId = result.docId;
    } catch (error) {
      if (this.proposal?.proposalId !== id) return;
      this.decision = 'uncertain';
      this.actionError =
        error instanceof Error
          ? error.message
          : 'Could not verify this action. Check the document.';
    } finally {
      this.saving = false;
    }
  }

  private renderProposal() {
    const proposal = this.proposal;
    if (!proposal) return nothing;
    const disabled = this.saving || this.decision !== 'proposed';
    return html`<section
      class="document-edit-preview"
      aria-label="Document change preview"
    >
      <strong
        >${
          proposal.operation === 'create' ? 'New document' : 'Document change'
        }:
        ${proposal.title}</strong
      >
      <p>
        ${
          this.decision === 'applied'
            ? 'Saved to document.'
            : this.decision === 'cancelled'
              ? 'Cancelled. Nothing was changed.'
              : 'Review before saving. Your document permissions still apply.'
        }
      </p>
      ${
        proposal.docId
          ? html`<small>Document: ${proposal.docId}</small>`
          : nothing
      }
      ${
        proposal.before
          ? html`<details>
              <summary>Before</summary>
              <pre>${proposal.before}</pre>
            </details>`
          : nothing
      }
      <details open>
        <summary>
          Proposed ${proposal.operation === 'rename' ? 'title' : 'content'}
        </summary>
        <pre>${proposal.after}</pre>
      </details>
      ${
        this.actionError
          ? html`<p role="alert">${this.actionError}</p>`
          : nothing
      }
      ${
        this.decision === 'uncertain'
          ? html`<p role="status">
              This preview is unavailable or its outcome is uncertain. Check the
              document and request a fresh preview if needed.
            </p>`
          : nothing
      }
      <div class="document-edit-actions">
        <button ?disabled=${disabled} @click=${() => this.decide('apply')}>
          ${this.saving ? 'Checking…' : 'Apply'}
        </button>
        <button ?disabled=${disabled} @click=${() => this.decide('cancel')}>
          Cancel
        </button>
        ${
          this.savedDocId || proposal.docId
            ? html`<button
                @click=${() => this.openDoc(this.savedDocId ?? proposal.docId)}
              >
                Open document
              </button>`
            : nothing
        }
      </div>
      <small
        >Previews expire after 15 minutes. Changes made since this preview
        require a new preview.</small
      >
    </section>`;
  }

  @property({ attribute: false })
  accessor data!: DocWriteToolCall | DocWriteToolResult;

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  private getDocId() {
    const { data } = this;
    if (
      data.type === 'tool-result' &&
      data.result &&
      !isToolError(data.result)
    ) {
      const docId =
        typeof data.result.docId === 'string' ? data.result.docId : undefined;
      if (docId) return docId;
    }
    const docId = data.args.doc_id;
    return typeof docId === 'string' && docId.trim() ? docId : undefined;
  }

  private getDocTitle(docId?: string) {
    const { data } = this;
    if (data.toolName === 'doc_create' || data.toolName === 'doc_update_meta') {
      const title = data.args.title;
      if (title) return title;
    }
    if (docId && this.docDisplayService) {
      const title = this.docDisplayService.getTitle(docId);
      if (title) return title;
    }
    return undefined;
  }

  private getToolIcon() {
    return this.data.toolName === 'doc_create' ? PageIcon() : PenIcon();
  }

  private getCallLabel(title?: string) {
    switch (this.data.toolName) {
      case 'doc_create':
        return title ? `Preparing "${title}"` : 'Preparing document preview';
      case 'doc_update':
        return title
          ? `Preparing edits to "${title}"`
          : 'Preparing edit preview';
      case 'doc_update_meta':
        return title ? `Proposing title "${title}"` : 'Preparing title preview';
      default:
        return 'Updating document';
    }
  }

  private getResultLabel(title?: string) {
    switch (this.data.toolName) {
      case 'doc_create':
        return title ? `Created "${title}"` : 'Document created';
      case 'doc_update':
        return title ? `Updated "${title}"` : 'Document updated';
      case 'doc_update_meta':
        return title ? `Renamed "${title}"` : 'Document title updated';
      default:
        return 'Document updated';
    }
  }

  private openDoc(docId?: string) {
    if (!docId) return;
    if (this.peekViewService) {
      this.peekViewService.peekView
        .open({ type: 'doc', docRef: { docId } })
        .catch(console.error);
      return;
    }
    this.onOpenDoc?.(docId);
  }

  renderToolCall() {
    const docId = this.getDocId();
    const title = this.getDocTitle(docId);
    return html`<tool-call-card
      .name=${this.getCallLabel(title)}
      .icon=${this.getToolIcon()}
      .width=${this.width}
    ></tool-call-card>`;
  }

  renderToolResult() {
    if (this.data.type !== 'tool-result') {
      return nothing;
    }

    const result = this.data.result;
    if (!result || isToolError(result)) {
      const name = isToolError(result) ? result.name : 'Document action failed';
      return html`<tool-call-failed
        .name=${name}
        .icon=${this.getToolIcon()}
      ></tool-call-failed>`;
    }

    if (this.proposal) return this.renderProposal();
    const docId = this.getDocId();
    const title = this.getDocTitle(docId) ?? 'Document';
    const parts: string[] = [];
    if (result.message) parts.push(result.message);
    if (docId) parts.push(`Doc ID: ${docId}`);
    const content = parts.length ? parts.join('\n') : undefined;

    return html`<tool-result-card
      .name=${this.getResultLabel(title)}
      .icon=${this.getToolIcon()}
      .width=${this.width}
      .results=${[
        {
          title,
          icon: PageIcon(),
          content,
          onClick: () => this.openDoc(docId),
        },
      ]}
    ></tool-result-card>`;
  }

  protected override render() {
    if (this.data.type === 'tool-call') {
      return this.renderToolCall();
    }
    if (this.data.type === 'tool-result') {
      return this.renderToolResult();
    }
    return nothing;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'doc-write-tool': DocWriteTool;
  }
}
