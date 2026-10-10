/**
 * @vitest-environment happy-dom
 */
import { render } from 'lit';
import { expect, test, vi } from 'vitest';

import { UnsupportedChatOptionsError } from '../provider/error';
import { AIChatErrorRenderer, AIErrorWrapper } from './error';

test('unsupported options explain how to resend without misleading support/retry actions', async () => {
  // The shared Lit setup stubs the registry; this test renders a real element.
  vi.unstubAllGlobals();
  if (!customElements.get('ai-error-wrapper')) {
    customElements.define('ai-error-wrapper', AIErrorWrapper);
  }
  const container = document.createElement('div');
  document.body.append(container);
  try {
    const retry = vi.fn();
    render(
      AIChatErrorRenderer(
        new UnsupportedChatOptionsError('untrusted provider diagnostic'),
        null,
        retry
      ),
      container
    );
    const wrapper = container.querySelector<AIErrorWrapper>('ai-error-wrapper');
    expect(wrapper).toBeInstanceOf(AIErrorWrapper);
    await wrapper?.updateComplete;
    expect(wrapper?.text).toContain('Extended Thinking');
    expect(wrapper?.text).toContain('web search');
    expect(wrapper?.text).toContain('send your message again');
    expect(wrapper?.showAction).toBe(false);
    expect(wrapper?.showDetailPanel).toBe(false);
    expect(wrapper?.shadowRoot?.textContent).not.toContain('untrusted');
    expect(
      wrapper?.shadowRoot?.querySelector(
        '[data-testid="ai-error-action-button"]'
      )
    ).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  } finally {
    render(null, container);
    container.remove();
  }
});
