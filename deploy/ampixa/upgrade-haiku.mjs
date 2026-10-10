import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  BackendRuntime,
} = require('/opt/affine/app/dist/server-native.x64.node');
const owners = JSON.parse(await readFile(process.argv[2], 'utf8'));
const modelId = 'claude-haiku-5-5';
const runtime = new BackendRuntime(
  await readFile('/var/lib/affine/.affine/config/private.key', 'utf8'),
  ['/var/lib/affine/.affine/config/config.json']
);
try {
  await runtime.start();
  for (const { workspaceId, actorUserId } of owners) {
    const profiles = await runtime.listByokProfiles(workspaceId);
    if (profiles.length !== 1 || profiles[0].name !== 'Claude Haiku')
      throw new Error('Unexpected workspace AI configuration');
    let profile = profiles[0];
    if (
      profile.definition.endpoint.url !== 'http://127.0.0.1:3011/v1' ||
      profile.definition.models.length !== 1
    )
      throw new Error('Unexpected Haiku endpoint or model list');
    if (profile.definition.models[0].modelId !== modelId) {
      const definition = structuredClone(profile.definition);
      definition.models[0].modelId = modelId;
      try {
        profile = await runtime.replaceByokProfile({
          workspaceId,
          profileId: profile.profileId,
          expectedRevision: profile.revision,
          name: profile.name,
          description: profile.description,
          definition,
          enabled: true,
          actorUserId,
        });
      } catch (error) {
        if (error.message !== 'embedding_unavailable') throw error;
        const saved = await runtime.listByokProfiles(workspaceId);
        if (
          saved.length !== 1 ||
          saved[0].profileId !== profile.profileId ||
          saved[0].revision !== profile.revision + 1 ||
          saved[0].definition.models[0].modelId !== modelId
        )
          throw error;
        profile = saved[0];
        console.warn(
          `Workspace ${workspaceId}: model updated; embedding reconciliation unavailable`
        );
      }
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
      probe.models.some(model =>
        model.checks.some(check => check.status.kind !== 'verified')
      )
    )
      throw new Error(
        `Haiku 5.5 probe failed for workspace ${workspaceId}: ${JSON.stringify(probe)}`
      );
    console.log(
      `Workspace ${workspaceId}: Haiku 5.5 chat, structured output, and tool calling verified`
    );
  }
} finally {
  await runtime.stop();
}
