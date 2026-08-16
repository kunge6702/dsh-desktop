import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import packaging from '../scripts/after-pack.cjs';

async function writeManifest(directory, manifest) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest), 'utf8');
}

test('packaged dependency checks cannot resolve through the outer development tree', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-packaging-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeModules = path.join(root, 'dist', 'resources', 'dsh-runtime', 'node_modules');

  await writeManifest(path.join(runtimeModules, 'fixture-source'), {
    name: 'fixture-source',
    version: '1.0.0',
    peerDependencies: { 'fixture-dependency': '1.0.0' },
  });
  await writeManifest(path.join(root, 'node_modules', 'fixture-dependency'), {
    name: 'fixture-dependency',
    version: '1.0.0',
  });

  assert.throws(
    () => packaging.assertDependencyClosure(runtimeModules),
    /fixture-source -> fixture-dependency/,
  );

  await writeManifest(path.join(runtimeModules, 'fixture-dependency'), {
    name: 'fixture-dependency',
    version: '1.0.0',
  });
  assert.doesNotThrow(() => packaging.assertDependencyClosure(runtimeModules));
});
