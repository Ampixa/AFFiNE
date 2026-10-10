import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
const scriptPath = name => fileURLToPath(new URL(name, import.meta.url));
if (
  !existsSync('/.dockerenv') ||
  process.env.AFFINE_DEPLOY_TEST_SANDBOX !== '1' ||
  existsSync('/opt/affine')
)
  throw new Error(
    'Only run in the explicitly designated disposable builder with no /opt/affine'
  );
const base = '/tmp/release-helper-fixtures';
const sha = 'a'.repeat(40),
  old = 'b'.repeat(40);
const fixturePaths = [
  '/opt/affine',
  '/etc/affine',
  '/var/lib/affine/.affine',
  '/etc/systemd/system/affine.service',
  '/etc/systemd/system/affine.service.d',
  '/etc/systemd/system/affine-claude-files.service',
];
for (const p of fixturePaths)
  assert.ok(!existsSync(p), `Fixture path exists: ${p}`);
const put = (p, t) => {
  mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true });
  writeFileSync(p, t);
};
const hash = t => createHash('sha256').update(t).digest('hex');
mkdirSync(base, { recursive: true });
put(
  base + '/shim.mjs',
  `#!/usr/local/bin/node
import fs from 'node:fs';
const base='${base}'; const command=process.argv[1].split('/').pop(); const args=process.argv.slice(2); const joined=args.join(' ');
fs.appendFileSync(base+'/calls',command+' '+joined+'\\n');
const mode=fs.readFileSync(base+'/mode','utf8');
if(command==='systemctl'){
 if(args[0]==='show') console.log(joined.includes('WorkingDirectory')?'/opt/affine/app':'affine');
 if(args[0]==='start' && mode==='start-fails' && !fs.existsSync(base+'/failed-once')){fs.writeFileSync(base+'/failed-once','1');process.exit(1)}
}else if(command==='sudo'){
 if(joined.includes('pg_database_size')) console.log(1024);
 else if(joined.includes('_prisma_migrations')) console.log(JSON.stringify([{migration_name:'001',checksum:mode==='migration-mismatch'?'bad':'${hash('SELECT 1;')}',finished:true}]));
 else if(joined.includes('_data_migrations')) console.log(JSON.stringify([{name:'Initial',finished:true}]));
 else if(joined.includes('pg_dump')) {if(mode==='backup-fails')process.exit(1);console.log('mock dump')}
 else if(joined.includes('pg_restore')) {} else process.exit(2);
}else if(command==='curl')console.log(JSON.stringify({compatibility:'0.27.4'}));
else if(command!=='sleep')process.exit(2);
`
);
chmodSync(base + '/shim.mjs', 0o755);
mkdirSync(base + '/bin', { recursive: true });
for (const c of ['sudo', 'systemctl', 'curl', 'sleep'])
  execFileSync('ln', ['-sf', base + '/shim.mjs', base + '/bin/' + c]);
const env = { ...process.env, PATH: base + '/bin:' + process.env.PATH };
function reset(mode = 'success') {
  for (const p of fixturePaths) rmSync(p, { recursive: true, force: true });
  for (const p of ['release', 'failed-once', 'calls'])
    rmSync(base + '/' + p, { recursive: true, force: true });
  put(base + '/mode', mode);
  put(base + '/calls', '');
  put('/opt/affine/app/dist/main.js', 'old app');
  put('/opt/affine/app/SOURCE_COMMIT', old + '\n');
  put(
    '/opt/affine/node',
    '#!/bin/sh\nif [ "$1" = --version ]; then echo v22.23.2; fi\n'
  );
  chmodSync('/opt/affine/node', 0o755);
  put('/etc/affine/secret.env', 'synthetic-secret');
  put('/var/lib/affine/.affine/config/private.key', 'synthetic-private-key');
  put('/etc/systemd/system/affine.service', 'synthetic-unit');
  put(
    '/etc/systemd/system/affine.service.d/30-claude-files.conf',
    'synthetic-drop-in'
  );
  put(
    '/etc/systemd/system/affine-claude-files.service',
    'synthetic-gateway-unit'
  );
  const r = base + '/release';
  for (const [name, text] of Object.entries({
    SOURCE_COMMIT: sha + '\n',
    BUILD_VALIDATED: 'validated',
    APP_VERSION: '0.27.4',
    'RELEASE.json': JSON.stringify({
      source_commit: sha,
      node: 'v22.23.2',
      target: 'linux-x86_64-glibc',
      app_version: '0.27.4',
    }),
    'DATA_MIGRATION_NAMES.json': '["Initial"]',
    'verify-native.cjs': '',
    'app/dist/main.js': 'new app',
    'app/dist/server-native.x64.node': 'fixture only',
    'app/migrations/001/migration.sql': 'SELECT 1;',
  }))
    put(r + '/' + name, text);
  execFileSync(
    'bash',
    [
      '-c',
      'find . -type f ! -name FILES.sha256 -print0 | sort -z | xargs -0 sha256sum > FILES.sha256',
    ],
    { cwd: r }
  );
}
const run = (script, args) =>
  spawnSync('bash', [scriptPath(script), ...args], { env, encoding: 'utf8' });
const checks = (newApp = false) => {
  assert.equal(
    readFileSync('/opt/affine/app/dist/main.js', 'utf8'),
    newApp ? 'new app' : 'old app'
  );
  assert.equal(
    readFileSync('/etc/affine/secret.env', 'utf8'),
    'synthetic-secret'
  );
  assert.equal(
    readFileSync(
      '/etc/systemd/system/affine.service.d/30-claude-files.conf',
      'utf8'
    ),
    'synthetic-drop-in'
  );
  assert.ok(
    !readFileSync(base + '/calls', 'utf8').includes('start affine-claude-files')
  );
};
try {
  if (spawnSync('id', ['affine']).status !== 0)
    execFileSync('useradd', ['--system', 'affine']);
  reset();
  let r = run('deploy-release.sh', [base + '/release', sha, '--check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  checks();
  assert.ok(!readFileSync(base + '/calls', 'utf8').includes('stop affine'));
  console.log('PASS preflight leaves the service and app untouched');
  reset('migration-mismatch');
  r = run('deploy-release.sh', [base + '/release', sha]);
  assert.notEqual(r.status, 0);
  checks();
  assert.ok(!readFileSync(base + '/calls', 'utf8').includes('stop affine'));
  console.log('PASS migration mismatch blocks deployment before downtime');
  reset();
  put(base + '/release/app/dist/main.js', 'tampered');
  r = run('deploy-release.sh', [base + '/release', sha]);
  assert.notEqual(r.status, 0);
  checks();
  console.log('PASS tampered artifact blocks deployment');
  reset('backup-fails');
  r = run('deploy-release.sh', [base + '/release', sha]);
  assert.notEqual(r.status, 0);
  checks();
  assert.match(readFileSync(base + '/calls', 'utf8'), /systemctl start affine/);
  console.log('PASS backup failure restarts the existing application');
  reset('start-fails');
  r = run('deploy-release.sh', [base + '/release', sha]);
  assert.notEqual(r.status, 0);
  checks();
  console.log('PASS failed new-service start restores the old application');
  reset();
  r = run('deploy-release.sh', [base + '/release', sha]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  checks(true);
  assert.equal(
    readFileSync(base + '/release/app/dist/main.js', 'utf8'),
    'new app'
  );
  const backup = readFileSync('/opt/affine/LAST_RELEASE_BACKUP', 'utf8').trim();
  assert.equal(readFileSync(backup + '/app/dist/main.js', 'utf8'), 'old app');
  const archived = execFileSync(
    'tar',
    ['-tzf', backup + '/config-storage.tar.gz'],
    { encoding: 'utf8' }
  );
  assert.match(archived, /affine.service.d\/30-claude-files.conf/);
  assert.match(archived, /affine-claude-files.service/);
  console.log(
    'PASS successful switch preserves release, old app, keys and gateway drop-in backups'
  );
  r = run('rollback-release.sh', [old]);
  assert.notEqual(r.status, 0);
  checks(true);
  console.log('PASS wrong-SHA rollback blocked');
  r = run('rollback-release.sh', [sha]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  checks();
  console.log(
    'PASS rollback restores complete previous app without changing secrets or gateway'
  );
} finally {
  for (const p of fixturePaths) rmSync(p, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}
