import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  BackendRuntime,
  llmBuildCanonicalRequest,
  CopilotManagedTier,
} = require('/opt/affine/app/dist/server-native.x64.node');
const owners = JSON.parse(await readFile(process.argv[2], 'utf8'));
const runtime = new BackendRuntime(
  await readFile('/var/lib/affine/.affine/config/private.key', 'utf8'),
  ['/var/lib/affine/.affine/config/config.json']
);
try {
  await runtime.start();
  const access = {
    routeAllowed: true,
    managedTier: CopilotManagedTier.Standard,
    serverByok: true,
    localByok: false,
  };
  for (const { workspaceId, actorUserId } of owners) {
    await runtime.assertCopilotRoute({
      slot: 'chat.default',
      workspaceId,
      userId: actorUserId,
      access,
    });
    console.log(`Workspace ${workspaceId}: default chat route available`);
  }
  const { workspaceId, actorUserId } = owners[0];
  const result = await runtime.executeCopilot({
    slot: 'chat.default',
    workspaceId,
    userId: actorUserId,
    access,
    request: llmBuildCanonicalRequest({
      model: 'route-selected',
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
      maxTokens: 8,
    }),
  });
  const output = typeof result === 'string' ? JSON.parse(result) : result;
  if (output.result.model !== 'claude-haiku-5-5')
    throw new Error('Unexpected AI model');
  console.log(JSON.stringify(output));
} finally {
  await runtime.stop();
}
