import {
  CopilotQuotaExceeded,
  CopilotUnsupportedChatOptions,
  NetworkError,
} from '../../../base';

const LLM_TIMEOUT_ERROR_PREFIX = 'llm_timeout:';
// The native Responses adapter carries the gateway's validation message through
// as an HTTP transport error, including when Auto selects the file-chat profile.
// Match only this known rejection; never expose arbitrary provider error bodies.
const UNSUPPORTED_FILE_CHAT_OPTIONS =
  'Reasoning and web search are unavailable on the file-chat route';

function nativeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return typeof error === 'string' ? error : undefined;
}

export function mapNativeSemanticError(error: unknown): unknown {
  const message = nativeErrorMessage(error);
  if (message === 'access_unavailable') {
    return new CopilotQuotaExceeded();
  }
  if (
    message === UNSUPPORTED_FILE_CHAT_OPTIONS ||
    message === `http transport error: ${UNSUPPORTED_FILE_CHAT_OPTIONS}`
  ) {
    return new CopilotUnsupportedChatOptions();
  }
  if (message?.startsWith(LLM_TIMEOUT_ERROR_PREFIX)) {
    return new NetworkError(
      message.slice(LLM_TIMEOUT_ERROR_PREFIX.length).trim() ||
        'LLM request timed out'
    );
  }
  return error;
}
