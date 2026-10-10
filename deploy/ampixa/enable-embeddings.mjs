import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

export const MODEL = 'gemini-embedding-001';
export const PROFILE = 'Ampixa document embeddings';
export const DEFINITION = {
  endpoint: { kind: 'provider_default' },
  models: [
    {
      modelId: MODEL,
      enabled: true,
      capabilities: [
        {
          input: ['text'],
          output: ['embedding'],
          features: [],
          attachmentKinds: [],
          attachmentSources: [],
        },
      ],
    },
  ],
};

// Only these controlled messages reach the terminal. Native/HTTP/SQL errors can
// contain credentials or document content and must not be printed verbatim.
export class SetupError extends Error {}
const object = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function embeddingConfig(config) {
  if (
    !object(config) ||
    !object(config.copilot) ||
    !object(config.copilot.byok) ||
    config.copilot.enabled !== true ||
    config.copilot.byok.enabled !== true
  ) {
    throw new SetupError(
      'Enable Intelligence and server BYOK before provisioning embeddings.'
    );
  }
  const allowed = config.copilot.byok.allowedProviders;
  if (
    allowed !== undefined &&
    (!Array.isArray(allowed) || allowed.some(p => typeof p !== 'string'))
  ) {
    throw new SetupError('Invalid BYOK provider allowlist.');
  }
  // An omitted allowlist already includes Gemini in this release. Preserve
  // defaults, custom endpoints, Haiku, and every unrelated setting.
  if (allowed === undefined || allowed.includes('gemini'))
    return structuredClone(config);
  return {
    ...config,
    copilot: {
      ...config.copilot,
      byok: {
        ...config.copilot.byok,
        allowedProviders: [...allowed, 'gemini'],
      },
    },
  };
}

export async function readConfig(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile())
    throw new SetupError('Config must be a regular file, not a symlink.');
  const original = await readFile(path, 'utf8');
  let config;
  try {
    config = JSON.parse(original);
  } catch {
    throw new SetupError('Invalid JSON in AFFiNE config.');
  }
  const next = embeddingConfig(config);
  return {
    path,
    metadata,
    original,
    next,
    changed: !isDeepStrictEqual(config, next),
  };
}

export async function saveConfig(snapshot) {
  const { path, metadata, original, next, changed } = snapshot;
  if (
    (await readFile(path, 'utf8')) !== original ||
    !(await lstat(path)).isFile()
  ) {
    throw new SetupError(
      'Config changed during preflight; review it and retry.'
    );
  }
  if (!changed) return undefined;
  const backup = `${path}.before-embeddings-${randomUUID()}`;
  const temporary = `${path}.embeddings-${randomUUID()}`;
  await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await chown(temporary, metadata.uid, metadata.gid);
    await chmod(temporary, metadata.mode & 0o777);
    if (
      (await readFile(path, 'utf8')) !== original ||
      !(await lstat(path)).isFile()
    ) {
      throw new SetupError('Config changed while saving; review it and retry.');
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return backup;
}

export async function probeGemini(credential, fetcher = fetch) {
  if (!credential || /\s/.test(credential))
    throw new SetupError('Supply one Gemini API key on stdin.');
  let response;
  try {
    response = await fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': credential,
        },
        body: JSON.stringify({
          requests: ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY'].map(taskType => ({
            model: `models/${MODEL}`,
            content: {
              parts: [{ text: 'Synthetic AFFiNE embedding setup check.' }],
            },
            taskType,
            outputDimensionality: 1024,
          })),
        }),
      }
    );
  } catch {
    throw new SetupError('Gemini probe failed to connect or timed out.');
  }
  if (!response.ok)
    throw new SetupError(
      `Gemini probe failed (HTTP ${response.status}); check key, billing and quota.`
    );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new SetupError('Gemini returned an invalid embedding response.');
  }
  if (
    !Array.isArray(data.embeddings) ||
    data.embeddings.length !== 2 ||
    data.embeddings.some(
      e =>
        !Array.isArray(e.values) ||
        e.values.length !== 1024 ||
        !e.values.every(Number.isFinite) ||
        !e.values.some(v => v !== 0)
    )
  ) {
    throw new SetupError(
      'Gemini must return two finite, nonzero, 1024-dimensional embeddings.'
    );
  }
}

export function existingProfile(profiles) {
  const named = profiles.filter(p => p.name === PROFILE);
  // Fail closed on legacy/unknown declarations; never silently replace a key.
  if (profiles.some(p => !Array.isArray(p.definition?.models)))
    throw new SetupError('Legacy BYOK profiles require manual review.');
  const embeddings = profiles.filter(
    p =>
      p.enabled &&
      p.definition.models.some(
        m =>
          m.enabled &&
          m.capabilities?.some(c => c.output?.includes('embedding'))
      )
  );
  if (named.length > 1 || embeddings.some(p => p.name !== PROFILE)) {
    throw new SetupError(
      'An existing embedding provider requires manual migration; no profiles were changed.'
    );
  }
  if (
    named.length &&
    (named[0].provider !== 'gemini' ||
      !named[0].enabled ||
      !isDeepStrictEqual(
        JSON.parse(JSON.stringify(named[0].definition)),
        DEFINITION
      ))
  ) {
    throw new SetupError(
      'The named embedding profile differs; review it manually.'
    );
  }
  return named[0];
}

export function verifyPreflight(state) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(state.pgvector ?? '');
  if (!version || (Number(version[1]) === 0 && Number(version[2]) < 8)) {
    throw new SetupError(
      'The target database needs pgvector >= 0.8.0; upgrade the package AND extension first.'
    );
  }
  if (!state.workspaceReady || !state.ownerReady)
    throw new SetupError(
      'An AI/embedding-enabled workspace and its active owner are required.'
    );
  existingProfile(state.profiles);
}

export function databasePreflight(workspaceId, actorUserId, env = process.env) {
  if (!env.DATABASE_URL)
    throw new SetupError(
      'Load AFFiNE service environment first (DATABASE_URL is missing).'
    );
  try {
    // psql variables quote values; the connection secret stays out of argv.
    const output = execFileSync(
      'psql',
      [
        '-X',
        '-w',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        `workspace_id=${workspaceId}`,
        '-v',
        `actor_user_id=${actorUserId}`,
      ],
      {
        env: { ...env, PGDATABASE: env.DATABASE_URL, PGCONNECT_TIMEOUT: '10' },
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
        input: `SELECT json_build_object(
        'pgvector', (SELECT extversion FROM pg_extension WHERE extname='vector'),
        'workspaceReady', EXISTS(SELECT 1 FROM workspaces WHERE id=:'workspace_id' AND enable_ai AND enable_doc_embedding),
        'ownerReady', EXISTS(SELECT 1 FROM workspace_members m JOIN users u ON u.id=m.user_id
          WHERE m.workspace_id=:'workspace_id' AND m.user_id=:'actor_user_id' AND m.role='owner' AND m.state='active' AND NOT u.disabled),
        'profiles', COALESCE((SELECT json_agg(json_build_object('name', name, 'provider', provider, 'enabled', enabled, 'definition', definition))
          FROM ai_workspace_byok_configs WHERE workspace_id=:'workspace_id'), '[]'::json));`,
      }
    );
    const state = JSON.parse(output);
    verifyPreflight(state);
    return state;
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(
      'Database preflight failed; check service environment, schema and psql access.'
    );
  }
}

export function requireStoppedService() {
  let state;
  try {
    state = execFileSync(
      'systemctl',
      ['show', 'affine.service', '--property=ActiveState', '--value'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
  } catch {
    throw new SetupError(
      'Cannot verify affine.service state; use the documented systemd deployment.'
    );
  }
  if (state !== 'inactive')
    throw new SetupError(
      'Stop affine.service before --apply to avoid duplicate background workers.'
    );
}

export async function provision(
  runtime,
  { workspaceId, actorUserId, credential, managedTier },
  log = console.log
) {
  try {
    await runtime.start();
    const health = await runtime.embeddingHealth();
    if (!health.enabled)
      throw new SetupError(
        'Native embedding support is unavailable; check database migrations and pgvector.'
      );
    const policy = runtime.getByokPolicy();
    if (!policy.enabled || !policy.allowedProviders.includes('gemini'))
      throw new SetupError(
        'Effective BYOK policy blocks Gemini; check database/admin overrides.'
      );
    let profile = existingProfile(await runtime.listByokProfiles(workspaceId));
    if (!profile) {
      // Creation can commit before reconciliation fails. Do not retry blindly:
      // a later invocation detects the saved profile and probes its stored key.
      profile = await runtime.createByokProfile({
        workspaceId,
        actorUserId,
        provider: 'gemini',
        name: PROFILE,
        description:
          'Hosted document embeddings; chat remains on its existing provider.',
        enabled: true,
        credential,
        definition: structuredClone(DEFINITION),
      });
      log(`Created embedding profile: ${profile.profileId}`);
    } else
      log(
        `Reusing embedding profile: ${profile.profileId}; stored credential is unchanged.`
      );
    const result = await runtime.probeByokProfile({
      workspaceId,
      profileId: profile.profileId,
      checks: [{ modelId: MODEL, operation: 'embedding' }],
    });
    const checks = result.models?.find(m => m.modelId === MODEL)?.checks;
    if (
      result.stale ||
      result.connection?.kind !== 'verified' ||
      !checks?.some(
        c => c.operation === 'embedding' && c.status.kind === 'verified'
      )
    ) {
      throw new SetupError(
        'Stored embedding credential did not pass the native probe. Review the profile; it was not replaced.'
      );
    }
    await runtime.assertCopilotRoute({
      slot: 'index.embedding',
      workspaceId,
      access: {
        routeAllowed: true,
        managedTier,
        serverByok: true,
        localByok: false,
      },
    });
    log(
      'Server embedding route verified. Document indexing and source-chat acceptance are still required.'
    );
    return profile.profileId;
  } finally {
    await runtime.stop();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      owner: { type: 'string' },
      apply: { type: 'boolean', default: false },
      config: {
        type: 'string',
        default: '/var/lib/affine/.affine/config/config.json',
      },
      'private-key': {
        type: 'string',
        default: '/var/lib/affine/.affine/config/private.key',
      },
      native: {
        type: 'string',
        default: '/opt/affine/app/dist/server-native.x64.node',
      },
    },
  });
  if (!values.workspace || !values.owner || process.stdin.isTTY) {
    throw new SetupError(
      'Usage: pipe the key to node enable-embeddings.mjs --workspace ID --owner ID [--apply]. See EMBEDDINGS.md.'
    );
  }
  if (process.env.DEPLOYMENT_TYPE !== 'selfhosted')
    throw new SetupError(
      'Load the selfhosted AFFiNE service environment first.'
    );
  if (values.apply) requireStoppedService();
  const snapshot = await readConfig(resolve(values.config));
  databasePreflight(values.workspace, values.owner);
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 4096) throw new SetupError('API key input is too long.');
  }
  const credential = input.trim();
  await probeGemini(credential);
  if (!values.apply) {
    console.log(
      'Dry run passed: database, workspace, config and synthetic Gemini embeddings checked. No config/profile writes or workers started.'
    );
    return;
  }
  const native = createRequire(import.meta.url)(resolve(values.native));
  const rootKey = await readFile(resolve(values['private-key']), 'utf8');
  if (
    native.validateAppConfigValue(
      'copilot',
      'byok.allowedProviders',
      snapshot.next.copilot.byok.allowedProviders ?? [
        'openai',
        'anthropic',
        'gemini',
        'fal',
      ]
    ).length
  ) {
    throw new SetupError(
      'The installed native runtime rejects this provider policy.'
    );
  }
  const backup = await saveConfig(snapshot);
  if (backup) console.log(`Private config rollback backup: ${backup}`);
  try {
    await provision(new native.BackendRuntime(rootKey, [snapshot.path]), {
      workspaceId: values.workspace,
      actorUserId: values.owner,
      credential,
      managedTier: native.CopilotManagedTier.Standard,
    });
  } catch (error) {
    console.error(
      'Setup incomplete. Config/profile writes may have committed. Preserve the backup and inspect before retrying; no automatic rollback was attempted.'
    );
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof SetupError
        ? error.message
        : 'Embedding setup failed. Check paths, permissions and service health; sensitive error details were withheld.'
    );
    process.exitCode = 1;
  }
}
