import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  chown,
  copyFile,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function searchConfig(config, endpoint) {
  if (
    !object(config) ||
    (config.indexer !== undefined && !object(config.indexer))
  ) {
    throw new Error('Expected an AFFiNE configuration object.');
  }
  const provider = config.indexer?.provider ?? {};
  if (!object(provider))
    throw new Error('Expected an indexer provider object.');
  if (provider.type && provider.type !== 'manticoresearch') {
    throw new Error(
      'An existing non-Manticore provider must be migrated manually.'
    );
  }
  if (provider.endpoint && provider.endpoint !== endpoint) {
    throw new Error('An existing search endpoint must be migrated manually.');
  }
  if (provider.apiKey || provider.username || provider.password) {
    throw new Error(
      'An authenticated search provider must be configured manually.'
    );
  }
  return {
    ...config,
    indexer: {
      ...config.indexer,
      enabled: true,
      provider: { ...provider, type: 'manticoresearch', endpoint },
    },
  };
}

export async function enableSearch(configPath, endpoint, apply = false) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Use the loopback HTTP endpoint of the companion search service.'
    );
  }
  endpoint = url.origin;
  const metadata = await lstat(configPath);
  if (!metadata.isFile())
    throw new Error('Config must be a regular file, not a symlink.');
  const original = await readFile(configPath, 'utf8');
  const next = searchConfig(JSON.parse(original), endpoint);
  const response = await fetch(`${endpoint}/sql?mode=raw`, {
    method: 'POST',
    body: new URLSearchParams({ query: 'SELECT 1' }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Search health check failed (HTTP ${response.status}).`);
  const result = await response.json();
  if (
    !Array.isArray(result) ||
    result[0]?.error ||
    result[0]?.data?.[0]?.['1'] !== 1
  ) {
    throw new Error(
      'Search health check did not return the expected SQL result.'
    );
  }
  const changed = JSON.stringify(JSON.parse(original)) !== JSON.stringify(next);
  if (!apply || !changed) return { changed, applied: false };

  // Never print or discard the rest of the config: it may contain BYOK secrets.
  const backup = `${configPath}.before-search-${randomUUID()}`;
  const temporary = `${configPath}.search-${randomUUID()}`;
  await copyFile(configPath, backup, constants.COPYFILE_EXCL);
  await chmod(backup, 0o600);
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await chown(temporary, metadata.uid, metadata.gid);
    await chmod(temporary, metadata.mode & 0o777);
    // Do not overwrite a configuration changed while the service was checked.
    if ((await readFile(configPath, 'utf8')) !== original) {
      throw new Error(
        'Config changed during preflight; retry after reviewing it.'
      );
    }
    await rename(temporary, configPath);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { changed: true, applied: true, backup };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: 'string' },
        endpoint: { type: 'string', default: 'http://127.0.0.1:9308' },
        apply: { type: 'boolean', default: false },
      },
    });
    if (!values.config)
      throw new Error(
        'Usage: node enable-search.mjs --config /path/config.json [--apply]'
      );
    const result = await enableSearch(
      resolve(values.config),
      values.endpoint,
      values.apply
    );
    console.log(
      result.applied
        ? `Search config saved. Private rollback backup: ${result.backup}`
        : result.changed
          ? 'Search is healthy. Dry run: pass --apply to save the configuration.'
          : 'Search is healthy; configuration already matches.'
    );
  } catch (error) {
    // Parsing errors can contain config values; do not echo them.
    console.error(
      error instanceof SyntaxError
        ? 'Invalid JSON in configuration or health response.'
        : error.message
    );
    process.exitCode = 1;
  }
}
