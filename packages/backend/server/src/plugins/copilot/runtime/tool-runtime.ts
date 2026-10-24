/* oxlint-disable import/no-cycle -- Tools can invoke nested prompts and semantic search. */
import { forwardRef, Inject, Injectable } from '@nestjs/common';

import { Config } from '../../../base';
import { DocReader } from '../../../core/doc';
import { PermissionAccess } from '../../../core/permission';
import { Models } from '../../../models';
import { DelegatedEditorService } from '../delegated/service';
import {
  type CopilotChatOptions,
  type CopilotChatTools,
} from '../providers/types';
import { ArtifactRetrievalService } from '../retrieval/artifact';
import { DocumentRetrievalService } from '../retrieval/document';
import {
  buildDocCanvasGetter,
  buildDocContentGetter,
  buildDocumentSearch,
  type CopilotTool,
  type CopilotToolSet,
  createArtifactReadTool,
  createArtifactSearchTool,
  createCodeArtifactTool,
  createConversationSummaryTool,
  createDocCanvasReadTool,
  createDocComposeTool,
  createDocCreateTool,
  createDocReadTool,
  createDocSearchTool,
  createDocUpdateMetaTool,
  createDocUpdateTool,
  createExaCrawlTool,
  createExaSearchTool,
  createFrontendEditorStateTool,
  createFrontendNodesTool,
  createFrontendSelectionTool,
  createFrontendSnapshotTool,
  createSectionEditTool,
} from '../tools';
import { DocumentEditing } from './document-editing';
import { PromptRuntime } from './prompt-runtime';

export type ProviderSpecificToolResolver = (
  toolName: CopilotChatTools,
  model: string
) => [string, CopilotTool?] | undefined;

@Injectable()
export class ToolRuntime {
  constructor(
    private readonly config: Config,
    private readonly ac: PermissionAccess,
    private readonly docReader: DocReader,
    private readonly models: Models,
    @Inject(forwardRef(() => PromptRuntime))
    private readonly promptRuntime: Pick<PromptRuntime, 'runText'>,
    private readonly retrieval: DocumentRetrievalService,
    private readonly artifactRetrieval: ArtifactRetrievalService,
    private readonly delegated: DelegatedEditorService,
    private readonly documentEditing: DocumentEditing
  ) {}

  async getTools(
    options: CopilotChatOptions,
    model: string,
    resolveProviderSpecificTool?: ProviderSpecificToolResolver
  ): Promise<CopilotToolSet> {
    const tools: CopilotToolSet = {};
    if (!options?.tools?.length) {
      return tools;
    }
    const runPromptText = (
      promptName: string,
      params: Record<string, unknown>
    ) =>
      this.promptRuntime.runText(promptName, params, {
        providerOptions: {
          user: options.user,
          session: options.session,
          workspace: options.workspace,
          byokLeaseId: options.byokLeaseId,
          billingUnitId: options.billingUnitId,
          quotaBackedRoutesAllowed: options.quotaBackedRoutesAllowed,
          featureKind: options.featureKind,
        },
      });

    const documentScope =
      options.retrievalScope?.mode === 'required'
        ? {
            mode: 'selected' as const,
            allowedDocIds: options.retrievalScope.requiredDocIds,
          }
        : undefined;

    for (const tool of options.tools) {
      if (['docCreate', 'docUpdate', 'docUpdateMeta'].includes(tool)) {
        if (options.documentEditScope) {
          if (tool === 'docCreate' && options.documentEditScope.allowCreate) {
            tools.doc_create = createDocCreateTool((title, content) =>
              this.documentEditing.propose(options, {
                operation: 'create',
                title,
                content,
              })
            );
          } else if (
            tool === 'docUpdate' &&
            options.documentEditScope.documents.length
          ) {
            tools.doc_update = createDocUpdateTool((docId, content) =>
              this.documentEditing.propose(options, {
                operation: 'update',
                docId,
                content,
              })
            );
          } else if (
            tool === 'docUpdateMeta' &&
            options.documentEditScope.documents.length
          ) {
            tools.doc_update_meta = createDocUpdateMetaTool((docId, title) =>
              this.documentEditing.propose(options, {
                operation: 'rename',
                docId,
                title,
              })
            );
          }
          const name =
            tool === 'docCreate'
              ? 'doc_create'
              : tool === 'docUpdate'
                ? 'doc_update'
                : 'doc_update_meta';
          if (tools[name])
            tools[name].description =
              'Propose a document change for user review. This does NOT save anything. The user must Apply the preview. ' +
              tools[name].description;
        }
        // Never fall through to immediate writes, including dev/canary/browser retries.
        continue;
      }
      const toolDef = resolveProviderSpecificTool?.(tool, model);
      if (toolDef) {
        if (toolDef[1]) {
          tools[toolDef[0]] = toolDef[1];
        }
        continue;
      }

      switch (tool) {
        case 'artifactRead': {
          tools.artifact_read = createArtifactReadTool(
            this.artifactRetrieval,
            options
          );
          break;
        }
        case 'artifactSearch': {
          tools.artifact_search = createArtifactSearchTool(
            this.artifactRetrieval,
            options
          );
          break;
        }
        case 'codeArtifact': {
          tools.code_artifact = createCodeArtifactTool(runPromptText);
          break;
        }
        case 'conversationSummary': {
          tools.conversation_summary = createConversationSummaryTool(
            options.session,
            runPromptText
          );
          break;
        }
        case 'docRead': {
          const getDoc = buildDocContentGetter(
            this.ac,
            this.docReader,
            this.models,
            documentScope
          );
          tools.doc_read = createDocReadTool(getDoc.bind(null, options));
          break;
        }
        case 'docCanvasRead': {
          const readCanvas = buildDocCanvasGetter(
            this.ac,
            this.docReader,
            this.models,
            documentScope
          );
          tools.doc_canvas_read = createDocCanvasReadTool(
            readCanvas.bind(null, options)
          );
          break;
        }
        case 'docSearch': {
          tools.doc_search = createDocSearchTool(
            buildDocumentSearch(this.retrieval, options, documentScope)
          );
          break;
        }
        case 'frontendGetEditorState': {
          if (this.delegated.getLease(options, 'frontend_get_editor_state')) {
            tools.frontend_get_editor_state = createFrontendEditorStateTool(
              this.delegated,
              options
            );
          }
          break;
        }
        case 'frontendReadSelection': {
          if (this.delegated.getLease(options, 'frontend_read_selection')) {
            tools.frontend_read_selection = createFrontendSelectionTool(
              this.delegated,
              options
            );
          }
          break;
        }
        case 'frontendReadNodes': {
          if (this.delegated.getLease(options, 'frontend_read_nodes')) {
            tools.frontend_read_nodes = createFrontendNodesTool(
              this.delegated,
              options
            );
          }
          break;
        }
        case 'frontendSnapshotDocument': {
          if (this.delegated.getLease(options, 'frontend_snapshot_document')) {
            tools.frontend_snapshot_document = createFrontendSnapshotTool(
              this.delegated,
              options
            );
          }
          break;
        }
        case 'webSearch': {
          tools.web_search_exa = createExaSearchTool(this.config);
          tools.web_crawl_exa = createExaCrawlTool(this.config);
          break;
        }
        case 'docCompose': {
          tools.doc_compose = createDocComposeTool(runPromptText);
          break;
        }
        case 'sectionEdit': {
          tools.section_edit = createSectionEditTool(runPromptText);
          break;
        }
      }
    }

    return tools;
  }
}
