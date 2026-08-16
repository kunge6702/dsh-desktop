import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialize,
  isBareSpecifier,
  mapPhysicalPackage,
  resolve,
} from '../lib/runtime-loader.js';

test('recognizes only bare package specifiers', () => {
  assert.equal(isBareSpecifier('@deepseek-ai/dsh'), true);
  assert.equal(isBareSpecifier('node-pty'), true);
  assert.equal(isBareSpecifier('./local.js'), false);
  assert.equal(isBareSpecifier('node:path'), false);
  assert.equal(isBareSpecifier('file:///app.js'), false);
});

test('maps helper-launching packages to their physical unpacked paths', () => {
  const virtual = {
    url: 'file:///C:/app/resources/dsh-runtime.asar/node_modules/@vscode/ripgrep/lib/index.js',
    format: 'module',
  };
  assert.deepEqual(mapPhysicalPackage(virtual, ['@vscode/ripgrep']), {
    ...virtual,
    url: 'file:///C:/app/resources/dsh-runtime.asar.unpacked/node_modules/@vscode/ripgrep/lib/index.js',
  });
  assert.equal(mapPhysicalPackage(virtual, ['node-pty']), virtual);
});

test('retries missing bare packages from the packaged runtime anchor', async () => {
  initialize({
    runtimeParentURL: 'file:///C:/app/resources/dsh-runtime.asar/runtime-host.js',
    physicalPackagePrefixes: [],
  });
  const calls = [];
  const nextResolve = async (specifier, context) => {
    calls.push([specifier, context.parentURL]);
    if (calls.length === 1) {
      const error = new Error('missing');
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw error;
    }
    return { url: 'file:///C:/app/resources/dsh-runtime.asar/node_modules/fixture/index.js' };
  };

  const result = await resolve('fixture', { parentURL: 'file:///C:/Users/me/.dsh/profile.yml' }, nextResolve);
  assert.equal(result.url.endsWith('/node_modules/fixture/index.js'), true);
  assert.deepEqual(calls, [
    ['fixture', 'file:///C:/Users/me/.dsh/profile.yml'],
    ['fixture', 'file:///C:/app/resources/dsh-runtime.asar/runtime-host.js'],
  ]);
});
