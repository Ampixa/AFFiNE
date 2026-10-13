import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import {
  ClaudeFiles,
  createGateway,
  LIMITS,
  responseEvents,
} from './gateway.mjs';

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const pdf = Buffer.from('%PDF-1.4\nSynthetic protocol fixture');
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const docx = Buffer.from('504b030400000000', 'hex');
const file = (mime = 'application/pdf', bytes = pdf) => ({
  type: 'input_file',
  media_type: mime,
  file_data: bytes.toString('base64'),
});
const input = (parts = [file()], extra = {}) => ({
  model: 'claude-haiku-5-5',
  input: [
    {
      role: 'user',
      content: [
        ...parts,
        { type: 'input_text', text: 'What does the selected source say?' },
      ],
    },
  ],
  ...extra,
});
const json = value =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
const answer = (extra = {}) => ({
  content: [{ type: 'text', text: 'Synthetic answer.' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 12,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
  },
  ...extra,
});
function fixture() {
  let now = Date.now();
  const calls = [];
  const replies = [];
  let uploads = 0;
  const client = new ClaudeFiles({
    apiKey: 'test-provider-secret',
    workspaceId: 'test-workspace',
    now: () => now,
    fetchImpl: async (url, options) => {
      assert.ok(url.startsWith('https://api.anthropic.com/v1/'));
      assert.equal(options.headers['x-api-key'], 'test-provider-secret');
      calls.push({ url, ...options });
      if (url.endsWith('/files')) {
        uploads++;
        assert.equal(options.body.get('expires_in_seconds'), '3600');
        return json({
          id: `file_${uploads}`,
          expires_at: new Date(now + 3600_000).toISOString(),
        });
      }
      return replies.length ? replies.shift() : json(answer());
    },
  });
  return {
    client,
    calls,
    replies,
    advance: ms => (now += ms),
    uploads: () => uploads,
    messageCalls: () =>
      calls
        .filter(c => c.url.endsWith('/messages'))
        .map(c => JSON.parse(c.body)),
  };
}

test('PDF uploads once, reuses file ID, enables caching and preserves accounting', async () => {
  const f = fixture();
  const first = await f.client.request(input());
  const followup = input();
  followup.input.push(
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: 'Explain further' }
  );
  await f.client.request(followup);
  assert.equal(f.uploads(), 1);
  const calls = f.messageCalls();
  assert.deepEqual(calls[0].messages[0].content[0], {
    type: 'document',
    source: { type: 'file', file_id: 'file_1' },
  });
  assert.deepEqual(calls[1].messages[0], calls[0].messages[0]);
  assert.deepEqual(calls[0].cache_control, { type: 'ephemeral' });
  assert.equal(first.usage.input_tokens, 132);
  assert.equal(first.usage.input_tokens_details.cached_tokens, 100);
  assert.equal(first.usage.total_tokens, 137);
  assert.ok(
    !JSON.stringify([...f.client.files]).includes(pdf.toString('base64'))
  );
});

test('changed bytes, MIME, credential instance, and expiry cannot reuse the old file', async () => {
  const f = fixture();
  await f.client.request(input());
  await f.client.request(
    input([file('application/pdf', Buffer.from('%PDF-1.5 changed'))])
  );
  assert.equal(f.uploads(), 2);
  f.advance(LIMITS.reuseMs + 1);
  await f.client.request(input());
  assert.equal(f.uploads(), 3);
  const other = fixture();
  await other.client.request(input());
  assert.equal(other.uploads(), 1);
});

test('image data URL is uploaded and reused as an image block', async () => {
  const f = fixture();
  const request = input([
    {
      type: 'input_image',
      image_url: `data:image/png;base64,${png.toString('base64')}`,
    },
  ]);
  await f.client.request(request);
  await f.client.request(request);
  assert.equal(f.uploads(), 1);
  assert.equal(f.messageCalls()[0].messages[0].content[0].type, 'image');
});

test('DOCX uses hosted execution; pause_turn is continued within a bounded request', async () => {
  const f = fixture();
  f.replies.push(
    json(
      answer({
        stop_reason: 'pause_turn',
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'bash_code_execution',
            input: { command: 'python read.py' },
          },
        ],
        container: { id: 'container_test' },
      })
    )
  );
  const result = await f.client.request(input([file(DOCX, docx)]));
  assert.equal(f.uploads(), 1);
  const [first, second] = f.messageCalls();
  assert.deepEqual(first.messages[0].content[0], {
    type: 'container_upload',
    file_id: 'file_1',
  });
  assert.ok(first.tools.some(t => t.type === 'code_execution_20250825'));
  assert.equal(second.container, 'container_test');
  assert.equal(second.messages.at(-1).content[0].type, 'server_tool_use');
  assert.equal(result.output.length, 1);
  assert.equal(result.usage.total_tokens, 274);
  assert.ok(
    !(
      'container' in (await f.client.prepare(input([file(DOCX, docx)]))).request
    )
  );
});

test('hosted execution continuation is capped and cannot claim completion', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++)
    f.replies.push(
      json(answer({ stop_reason: 'pause_turn', container: { id: 'c' } }))
    );
  await assert.rejects(
    f.client.request(input([file(DOCX, docx)])),
    /continuation limit/
  );
  assert.equal(f.messageCalls().length, 3);
});

test('hosted tool errors and truncated answers fail rather than return success', async () => {
  const f = fixture();
  f.replies.push(
    json(
      answer({
        content: [
          {
            type: 'bash_code_execution_tool_result',
            content: {
              type: 'bash_code_execution_tool_result_error',
              error_code: 'unavailable',
            },
          },
        ],
      })
    )
  );
  await assert.rejects(
    f.client.request(input([file(DOCX, docx)])),
    /processing failed/
  );
  f.replies.push(json(answer({ stop_reason: 'max_tokens' })));
  await assert.rejects(f.client.request(input()), /output limit/);
});

test('TXT uses strict UTF-8 document blocks', async () => {
  const f = fixture();
  await f.client.request(input([file('text/plain', Buffer.from('नमस्कार'))]));
  assert.equal(f.uploads(), 0);
  assert.equal(
    f.messageCalls()[0].messages[0].content[0].source.data,
    'नमस्कार'
  );
  await assert.rejects(
    f.client.request(input([file('text/plain', Buffer.from([255]))])),
    /UTF-8/
  );
});

for (const [name, part] of Object.entries({
  'external URL': {
    type: 'input_image',
    image_url: 'http://169.254.169.254/latest/meta-data',
  },
  'foreign file ID': { type: 'input_file', file_id: 'file_someone_else' },
  'file handle': { type: 'input_file', file_handle: 'file_else' },
  'remote PDF': {
    type: 'input_file',
    file_url: 'https://example.com/file.pdf',
  },
  'legacy DOC': file('application/msword'),
  'wrong signature': file('image/png'),
  'invalid base64': { ...file(), file_data: '***' },
  'empty file': file('application/pdf', Buffer.alloc(0)),
}))
  test(`rejects ${name} before upload`, async () => {
    const f = fixture();
    await assert.rejects(f.client.request(input([part])));
    assert.equal(f.calls.length, 0);
  });

test('file count, individual and total limits checked before uploads', async () => {
  const f = fixture();
  await assert.rejects(
    f.client.request(input(Array.from({ length: 5 }, () => file()))),
    /four files/
  );
  const large = Buffer.alloc(LIMITS.file + 1, 32);
  pdf.copy(large);
  await assert.rejects(
    f.client.request(input([file('application/pdf', large)])),
    /5 MiB/
  );
  const medium = large.subarray(0, 3 * 1024 * 1024);
  await assert.rejects(
    f.client.request(
      input(Array.from({ length: 3 }, () => file('application/pdf', medium)))
    ),
    /8 MiB/
  );
  assert.equal(f.calls.length, 0);
});

test('function tools, results and structured output survive conversion', async () => {
  const f = fixture();
  const request = input([], {
    tools: [
      {
        type: 'function',
        name: 'docRead',
        description: 'Read a permitted page',
        parameters: { type: 'object' },
      },
    ],
    text: { format: { type: 'json_schema', schema: { type: 'object' } } },
  });
  request.input.push(
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'docRead',
      arguments: '{"id":"abc"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: '{"text":"A"}' }
  );
  f.replies.push(
    json(
      answer({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'docRead',
            input: { id: 'next' },
          },
        ],
      })
    )
  );
  const result = await f.client.request(request);
  const sent = f.messageCalls()[0];
  assert.equal(sent.tools[0].name, 'docRead');
  assert.equal(sent.messages.at(-1).content[0].tool_use_id, 'call_1');
  assert.deepEqual(sent.output_config.format.schema, { type: 'object' });
  assert.equal(result.output[0].arguments, '{"id":"next"}');
  assert.ok(
    responseEvents(result).some(
      e =>
        e.type === 'response.function_call_arguments.done' &&
        e.call_id === 'toolu_2'
    )
  );
});

test('disabled client tools remain disabled even when DOCX enables hosted processing', async () => {
  const f = fixture();
  await f.client.request(
    input([file(DOCX, docx)], {
      tools: [{ type: 'function', name: 'docUpdate' }],
      tool_choice: 'none',
    })
  );
  assert.deepEqual(f.messageCalls()[0].tools, [
    { type: 'code_execution_20250825', name: 'code_execution' },
  ]);
});

test('provider failures redact payloads and invalidate stale IDs for the next manual retry', async () => {
  const f = fixture();
  await f.client.request(input());
  f.replies.push(
    new Response('secret-document-content and secret-key', { status: 400 })
  );
  await assert.rejects(
    f.client.request(input()),
    error => error.status === 502 && !error.message.includes('secret')
  );
  assert.equal(f.client.files.size, 0);
  assert.equal(f.messageCalls().length, 2); // no automatic replay
  await f.client.request(input());
  assert.equal(f.uploads(), 2);
});

test('expiry must be confirmed; an unexpired upload is deleted if response omits expiry', async () => {
  const calls = [];
  const client = new ClaudeFiles({
    apiKey: 'test',
    fetchImpl: async (url, options) => {
      calls.push([url, options.method]);
      return json(
        options.method === 'DELETE' ? {} : { id: 'file_test', expires_at: null }
      );
    },
  });
  await assert.rejects(client.request(input()), /expiry/);
  assert.equal(calls[1][1], 'DELETE');
  assert.equal(client.files.size, 0);
});

test('cache metadata count is bounded', async () => {
  const f = fixture();
  for (let i = 0; i < LIMITS.cacheEntries + 2; i++)
    await f.client.fileId({
      mime: 'application/pdf',
      bytes: pdf,
      hash: String(i),
    });
  assert.equal(f.client.files.size, LIMITS.cacheEntries);
});

test('unsupported model, reasoning, state handles and oversized output fail before upload', async () => {
  for (const extra of [
    { model: 'other' },
    { reasoning: { effort: 'high' } },
    { previous_response_id: 'other' },
    { max_output_tokens: 100000 },
    { tools: [{ type: 'web_search' }] },
  ]) {
    const f = fixture();
    await assert.rejects(f.client.request(input([file()], extra)));
    assert.equal(f.calls.length, 0);
  }
});

async function serverFixture(t, client, options = {}) {
  const server = createGateway({
    client,
    gatewayKey: 'test-gateway-secret-long',
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) =>
    fetch(url + '/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-gateway-secret-long',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { server, url, post };
}

test('HTTP gateway authenticates, emits Responses SSE and exposes no file retrieval endpoint', async t => {
  const f = fixture();
  const s = await serverFixture(t, f.client);
  assert.equal(
    (await s.post(input(), { authorization: 'Bearer wrong' })).status,
    401
  );
  assert.equal(f.calls.length, 0);
  const response = await s.post(input([], { stream: true }));
  const wire = await response.text();
  assert.match(wire, /event: response.created/);
  assert.match(wire, /event: response.output_text.delta/);
  assert.match(wire, /event: response.completed/);
  assert.doesNotMatch(wire, /test-provider-secret/);
  assert.equal(
    (
      await fetch(s.url + '/v1/files/file_other', {
        headers: { authorization: 'Bearer test-gateway-secret-long' },
      })
    ).status,
    404
  );
});

test('SSE failures use response.error understood by the pinned native adapter', async t => {
  const f = fixture();
  f.replies.push(new Response('secret', { status: 500 }));
  const s = await serverFixture(t, f.client);
  const wire = await (await s.post(input([], { stream: true }))).text();
  assert.match(wire, /event: response.error/);
  assert.doesNotMatch(wire, /response.completed|secret/);
});

test('busy requests are rejected rather than queued in memory', async t => {
  let release, entered;
  const ready = new Promise(resolve => (entered = resolve));
  const pending = new Promise(resolve => (release = resolve));
  const s = await serverFixture(t, {
    model: 'test',
    request: async () => {
      entered();
      await pending;
      return { output: [] };
    },
  });
  const first = s.post({});
  await ready;
  assert.equal((await s.post({})).status, 429);
  release();
  assert.equal((await first).status, 200);
});

test('timeout aborts the provider and releases the request slot', async t => {
  let aborted = false;
  const s = await serverFixture(
    t,
    {
      model: 'test',
      request: async (_input, signal) => {
        await new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true }
          )
        );
      },
    },
    { timeoutMs: 30 }
  );
  const response = await s.post({});
  assert.equal(response.status, 504);
  assert.ok(aborted);
  assert.equal((await s.post({})).status, 504); // not a leaked busy slot
});

test('a stalled upload is cancelled and does not retain the active slot', async t => {
  let calls = 0;
  const s = await serverFixture(
    t,
    {
      model: 'test',
      request: async () => {
        calls++;
        return { output: [] };
      },
    },
    { timeoutMs: 40 }
  );
  const req = httpRequest(s.url + '/v1/responses', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-gateway-secret-long',
      'content-type': 'application/json',
      'content-length': '1000',
    },
  });
  const closed = new Promise(resolve => req.on('error', resolve));
  req.write('{');
  await closed;
  assert.equal(calls, 0);
  assert.equal((await s.post({})).status, 200);
});

test('invalid text after a PDF is rejected before any upload', async () => {
  const f = fixture();
  await assert.rejects(
    f.client.request(input([file(), file('text/plain', Buffer.from([255]))])),
    /UTF-8/
  );
  assert.equal(f.calls.length, 0);
});
