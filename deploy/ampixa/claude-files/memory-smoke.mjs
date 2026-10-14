import { fork } from 'node:child_process';
import { once } from 'node:events';
// Synthetic transport load check; no API credentials or network provider calls.
const gateway = new URL('./gateway.mjs', import.meta.url);
if (process.argv[2] === 'child') {
  const { ClaudeFiles, createGateway } = await import(gateway);
  let files = 0;
  const client = new ClaudeFiles({
    apiKey: 'synthetic-only',
    fetchImpl: async url =>
      new Response(
        JSON.stringify(
          url.endsWith('/files')
            ? {
                id: `file_${++files}`,
                expires_at: new Date(Date.now() + 3600000).toISOString(),
              }
            : {
                content: [{ type: 'text', text: 'Synthetic answer' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              }
        )
      ),
  });
  const server = createGateway({
    client,
    gatewayKey: 'synthetic-test-credential',
  });
  server.listen(0, '127.0.0.1', () =>
    process.send({ port: server.address().port })
  );
  process.on('message', () => {
    process.send({
      peakMiB: process.resourceUsage().maxRSS / 1024,
      uploads: files,
    });
    server.closeAllConnections();
    server.close();
    process.disconnect();
  });
} else {
  const child = fork(new URL(import.meta.url), ['child'], {
    execArgv: ['--max-old-space-size=128'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const [{ port }] = await once(child, 'message');
  const bytes = Buffer.alloc(4 * 1024 * 1024, 32);
  bytes.write('%PDF-1.4');
  const bytes2 = Buffer.from(bytes);
  bytes2[20] = 65;
  const body = JSON.stringify({
    model: 'claude-haiku-5-5',
    input: [
      {
        role: 'user',
        content: [bytes, bytes2].map(b => ({
          type: 'input_file',
          media_type: 'application/pdf',
          file_data: b.toString('base64'),
        })),
      },
    ],
  });
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic-test-credential',
        'content-type': 'application/json',
      },
      body,
    });
    if (response.status !== 200) throw new Error(await response.text());
    await response.text();
  }
  child.send('done');
  const [result] = await once(child, 'message');
  console.log(JSON.stringify(result));
  await once(child, 'exit');
}
