import { defineModuleConfig } from '../../base';

declare global {
  interface AppConfigSchema {
    copilotSelfHosted: {
      documentSearchFallback: boolean;
      disableReasoning: boolean;
    };
  }
}

defineModuleConfig('copilotSelfHosted', {
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
