import test from 'ava';

import {
  CopilotQuotaExceeded,
  CopilotUnsupportedChatOptions,
  NetworkError,
} from '../../base';
import { mapNativeSemanticError } from '../../plugins/copilot/runtime/native-errors';

const rejection =
  'Reasoning and web search are unavailable on the file-chat route';

test('known file-chat option rejections serialize as actionable client errors', t => {
  for (const message of [rejection, `http transport error: ${rejection}`]) {
    for (const input of [message, new Error(message), { message }]) {
      const error = mapNativeSemanticError(input);
      t.true(error instanceof CopilotUnsupportedChatOptions);
      if (!(error instanceof CopilotUnsupportedChatOptions)) continue;
      t.like(error.toJSON(), {
        status: 400,
        type: 'BAD_REQUEST',
        name: 'COPILOT_UNSUPPORTED_CHAT_OPTIONS',
      });
      t.regex(error.message, /Extended Thinking/);
      t.regex(error.message, /send your message again/);
      t.false(error.message.includes('http transport'));
    }
  }
});

test('unknown provider errors and non-errors are not relabeled as option errors', t => {
  for (const error of [
    new Error('http transport error: upstream unavailable'),
    new Error(`${rejection}: private-provider-details`),
    new Error(`Provider returned: ${rejection}`),
    new Error('Unsupported tool'),
    new CopilotUnsupportedChatOptions(),
    { status: 500 },
    undefined,
    null,
  ]) {
    t.is(mapNativeSemanticError(error), error);
  }
});

test('quota and timeout mappings remain intact', t => {
  t.true(
    mapNativeSemanticError(new Error('access_unavailable')) instanceof
      CopilotQuotaExceeded
  );
  t.true(
    mapNativeSemanticError(
      new Error('llm_timeout: request timed out')
    ) instanceof NetworkError
  );
});
