import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Run as the affine user with its production environment loaded.
// Input is a JSON array of { workspaceId, actorUserId } owner records.
const require = createRequire(import.meta.url);
const {
  BackendRuntime,
} = require('/opt/affine/app/dist/server-native.x64.node');
const env = process.env;
if (!env.LITELLM_MASTER_KEY) throw new Error('Gateway credential is missing');
const owners = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!Array.isArray(owners) || !owners.length)
  throw new Error('No workspace owners');
const key = await readFile(
  '/var/lib/affine/.affine/config/private.key',
  'utf8'
);
const runtime = new BackendRuntime(key, [
  '/var/lib/affine/.affine/config/config.json',
]);
try {
  await runtime.start();
  for (const { workspaceId, actorUserId } of owners) {
    if (!workspaceId || !actorUserId)
      throw new Error('Invalid workspace owner record');
    const existing = await runtime.listByokProfiles(workspaceId);
    if (
      existing.length &&
      (existing.length !== 1 || existing[0].name !== 'Claude Haiku')
    ) {
      throw new Error(
        `Workspace ${workspaceId} has unexpected profiles; refusing to overwrite`
      );
    }
    let profile = existing[0];
    if (!profile) {
      try {
        profile = await runtime.createByokProfile({
          workspaceId,
          actorUserId,
          provider: 'openai',
          name: 'Claude Haiku',
          description: 'Ampixa Haiku-only local gateway',
          enabled: true,
          credential: env.LITELLM_MASTER_KEY,
          definition: {
            endpoint: {
              kind: 'openai_compatible',
              url: 'http://127.0.0.1:3011/v1',
              dialect: 'chat_completions',
            },
            models: [
              {
                modelId: 'claude-haiku-4-5-20251001',
                enabled: true,
                capabilities: [
                  {
                    input: ['text', 'image'],
                    output: ['text', 'object', 'structured'],
                    features: ['tool_calling'],
                    attachmentKinds: ['image'],
                    attachmentSources: ['url', 'data'],
                  },
                ],
              },
            ],
          },
        });
      } catch (error) {
        if (error.message !== 'embedding_unavailable') throw error;
        // This release commits the profile before attempting embedding reconciliation.
        const committed = await runtime.listByokProfiles(workspaceId);
        if (committed.length !== 1 || committed[0].name !== 'Claude Haiku')
          throw error;
        profile = committed[0];
        console.warn(
          `Workspace ${workspaceId}: profile saved; embedding reconciliation unavailable`
        );
      }
    }
    if (
      profile.definition.models.length !== 1 ||
      profile.definition.models[0].modelId !== 'claude-haiku-4-5-20251001'
    ) {
      throw new Error('Existing profile is not Haiku-only');
    }
    const result = await runtime.probeByokProfile({
      workspaceId,
      profileId: profile.profileId,
      checks: [
        { modelId: 'claude-haiku-4-5-20251001', operation: 'chat' },
        { modelId: 'claude-haiku-4-5-20251001', operation: 'structured' },
        { modelId: 'claude-haiku-4-5-20251001', operation: 'tool_calling' },
      ],
    });
    if (
      result.connection.kind !== 'verified' ||
      result.stale ||
      result.models.some(model =>
        model.checks.some(check => check.status.kind !== 'verified')
      )
    ) {
      throw new Error(
        `Workspace ${workspaceId}: Haiku probe did not verify all requested capabilities`
      );
    }
    console.log(
      JSON.stringify({
        workspaceId,
        profileId: profile.profileId,
        probe: result,
      })
    );
  }
} finally {
  await runtime.stop();
}
