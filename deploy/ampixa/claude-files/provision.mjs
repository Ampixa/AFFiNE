import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Explicit maintainer action after installing the reviewed gateway. Reuses the
// gateway credential; never copies the Anthropic API key into AFFiNE profiles.
const require = createRequire(import.meta.url);
const {
  BackendRuntime,
} = require('/opt/affine/app/dist/server-native.x64.node');
const owners = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!Array.isArray(owners) || owners.length !== 1)
  throw new Error('Configure one workspace per file-gateway instance');
if (!process.env.LITELLM_MASTER_KEY)
  throw new Error('Gateway credential is missing');
const modelId = process.env.CLAUDE_FILE_MODEL || 'claude-haiku-5-5';
const name = 'Claude Haiku file chat';
const endpoint = {
  kind: 'openai_compatible',
  url: 'http://127.0.0.1:3012/v1',
  dialect: 'responses',
};
const runtime = new BackendRuntime(
  await readFile('/var/lib/affine/.affine/config/private.key', 'utf8'),
  ['/var/lib/affine/.affine/config/config.json']
);
const profiles = {};
try {
  await runtime.start();
  for (const { workspaceId, actorUserId } of owners) {
    if (!workspaceId || !actorUserId)
      throw new Error('Workspace owner is required');
    const matches = (await runtime.listByokProfiles(workspaceId)).filter(
      p => p.name === name
    );
    if (matches.length > 1)
      throw new Error(
        'Ambiguous file-chat profiles; inspect before continuing'
      );
    let profile = matches[0];
    if (!profile) {
      try {
        profile = await runtime.createByokProfile({
          workspaceId,
          actorUserId,
          provider: 'openai',
          name,
          description:
            'Claude Files API and prompt caching through the loopback file gateway',
          enabled: true,
          credential: process.env.LITELLM_MASTER_KEY,
          definition: {
            endpoint,
            models: [
              {
                modelId,
                enabled: true,
                capabilities: [
                  {
                    input: ['text', 'image', 'file'],
                    output: ['text', 'object', 'structured'],
                    features: ['tool_calling'],
                    attachmentKinds: ['image', 'file'],
                    attachmentSources: ['data', 'bytes'],
                  },
                ],
              },
            ],
          },
        });
      } catch (error) {
        if (error.message !== 'embedding_unavailable') throw error;
        const saved = (await runtime.listByokProfiles(workspaceId)).filter(
          p => p.name === name
        );
        if (saved.length !== 1) throw error;
        profile = saved[0];
      }
    }
    if (
      profile.provider !== 'openai' ||
      !profile.enabled ||
      profile.definition.endpoint.url !== endpoint.url ||
      profile.definition.endpoint.dialect !== 'responses' ||
      profile.definition.models.length !== 1 ||
      profile.definition.models[0].modelId !== modelId ||
      !profile.definition.models[0].capabilities.some(c =>
        c.attachmentKinds?.includes('file')
      )
    ) {
      throw new Error(
        'Existing file-chat profile differs; refusing to overwrite it'
      );
    }
    const probe = await runtime.probeByokProfile({
      workspaceId,
      profileId: profile.profileId,
      checks: ['chat', 'structured', 'tool_calling'].map(operation => ({
        modelId,
        operation,
      })),
    });
    if (
      probe.stale ||
      probe.connection.kind !== 'verified' ||
      probe.models.some(m => m.checks.some(c => c.status.kind !== 'verified'))
    ) {
      throw new Error(
        'File-chat route probe failed; do not enable the workspace file opt-in'
      );
    }
    profiles[workspaceId] = profile.profileId;
  }
  console.log(`AFFINE_CLAUDE_FILE_PROFILES=${JSON.stringify(profiles)}`);
  console.log(`AFFINE_CLAUDE_FILE_MODEL=${modelId}`);
} finally {
  await runtime.stop();
}
