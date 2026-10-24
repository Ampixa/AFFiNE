import { defineModuleConfig } from '../../base';

declare global {
  interface AppConfigSchema {
    copilotSelfHosted: {
      documentSearchFallback: boolean;
      documentEditing: boolean;
      disableReasoning: boolean;
    };
  }
}

defineModuleConfig('copilotSelfHosted', {
  documentEditing: {
    desc: 'Allow explicitly scoped browser chat document proposals. Saving requires a separate user Apply action.',
    default: true,
    env: ['AFFINE_COPILOT_DOCUMENT_EDITING', 'boolean'],
  },
  documentSearchFallback: {
    desc: 'Use bounded in-process document keyword search when indexed retrieval is unavailable. No attachment extraction or external service.',
    default: false,
    env: ['AFFINE_COPILOT_DOCUMENT_SEARCH_FALLBACK', 'boolean'],
  },
  disableReasoning: {
    desc: 'Reject Extended Thinking before provider requests on installations whose chat gateway does not support reasoning.',
    default: false,
    env: ['AFFINE_COPILOT_DISABLE_REASONING', 'boolean'],
  },
});
