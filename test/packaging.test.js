import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import asar from '@electron/asar';
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

test('optimized runtime layout requires an archive and caps loose files', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-layout-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const resources = path.join(root, 'resources');
  const archive = path.join(resources, 'dsh-runtime.asar');
  await fs.mkdir(path.join(source, 'node_modules', 'fixture'), { recursive: true });
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(source, 'node_modules', 'fixture', 'index.js'), 'export {};\n');
  await fs.writeFile(path.join(source, 'node_modules', 'fixture', 'native.node'), 'fixture');
  await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' });

  assert.equal(packaging.assertOptimizedRuntimeLayout(resources).looseFileCount, 1);
  assert.throws(
    () => packaging.assertOptimizedRuntimeLayout(resources, 0),
    /contains 1 loose files/,
  );
});

test('unsigned Windows resource editing writes product metadata and the icon', () => {
  const appInfo = {
    productName: 'DSH Desktop',
    productFilename: 'DSH Desktop',
    copyright: 'Copyright DSH Desktop contributors',
    shortVersion: '0.2.0',
    shortVersionWindows: '0.2.0.0',
    getVersionInWeirdWindowsForm: () => 'unused',
  };
  const options = packaging.windowsExecutableResourceOptions('favicon.ico', appInfo);
  assert.equal(options.icon, 'favicon.ico');
  assert.equal(options['version-string'].ProductName, 'DSH Desktop');
  assert.equal(options['file-version'], '0.2.0');
  assert.equal(options['product-version'], '0.2.0.0');
});
