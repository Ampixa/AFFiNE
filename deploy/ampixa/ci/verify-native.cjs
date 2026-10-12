const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
(async () => {
  assert.equal(process.arch, 'x64');
  assert.equal(process.platform, 'linux');
  assert.equal(typeof native.StorageRuntime, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'affine-native-check-'));
  const rt = new native.StorageRuntime();
  try {
    rt.configure(
      JSON.stringify({
        storages: {
          'blob.storage': {
            provider: 'fs',
            bucket: 'fixtures',
            config: { path: root },
          },
        },
      })
    );
    const bytes = Buffer.from('bounded-storage-release-fixture');
    await rt.putObject('blob', 'release-fixture/sample.txt', bytes, {
      contentType: 'text/plain',
    });
    const value = await rt.getObject(
      'blob',
      'release-fixture/sample.txt',
      bytes.length
    );
    assert.deepEqual(Buffer.from(value.body), bytes);
    await assert.rejects(
      rt.getObject('blob', 'release-fixture/sample.txt', bytes.length - 1),
      /resource_exceeded/
    );
    await assert.rejects(
      rt.getObject('blob', 'release-fixture/sample.txt', 0),
      /resource_exceeded/
    );
    assert.equal(
      await rt.getObject('blob', 'release-fixture/missing.txt', 100),
      null
    );
    console.log(
      'PASS: Linux x64 native module loads; bounded reads allow exact size and reject oversized fixtures.'
    );
  } finally {
    await rt.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
