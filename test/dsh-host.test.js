import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { activateWindow, registerSingleInstance } from '../lib/app-lifecycle.js';
import { DshHost, DshHostError } from '../lib/dsh-host.js';
import { installNavigationGuards, isAllowedNavigation } from '../lib/navigation-policy.js';

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.exitCode = null;
    this.pid = 1234;
    this.killed = false;
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => {
      if (this.exitCode !== null) return;
      this.exitCode = 0;
      this.emit('exit', 0, null);
    });
    return true;
  }
}

test('restores, shows, and focuses an existing main window', () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };

  assert.equal(activateWindow(window), true);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
  assert.equal(activateWindow(null), false);
  assert.equal(activateWindow({ isDestroyed: () => true }), false);
});

test('registers second-instance activation only for the lock owner', () => {
  const owner = new EventEmitter();
  owner.requestSingleInstanceLock = () => true;
  let activations = 0;

  assert.equal(registerSingleInstance(owner, () => { activations += 1; }), true);
  owner.emit('second-instance');
  assert.equal(activations, 1);

  const duplicate = new EventEmitter();
  duplicate.requestSingleInstanceLock = () => false;
  assert.equal(registerSingleInstance(duplicate, () => { activations += 1; }), false);
  duplicate.emit('second-instance');
  assert.equal(activations, 1);
});

test('starts DSH with a random loopback port and parses chunked readiness', async () => {
  let invocation;
  const child = new FakeChild();
  const host = new DshHost({
    entryPath: 'C:/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    spawnImpl: (...args) => { invocation = args; return child; },
    platform: 'linux',
    timeoutMs: 1000,
  });

  const starting = host.start('C:/workspace');
  child.stdout.emit('data', 'boot\n\u001b[32m');
  child.stdout.emit('data', 'dsh web: http://127.0.0.1:41');
  child.stdout.emit('data', '23\n');
  child.stderr.emit('data', 'a diagnostic\n');
  assert.equal(await starting, 'http://127.0.0.1:4123');
  assert.equal(invocation[0], process.execPath);
  assert.deepEqual(invocation[1].slice(0, 2), ['--expose-internals', 'C:/app/node_modules/@deepseek-ai/dsh/lib/bin.js']);
  assert.equal(invocation[2].cwd, 'C:/workspace');
  assert.equal(invocation[2].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(host.diagnostics().stderr, 'a diagnostic\n');

  await Promise.all([host.stop(), host.stop()]);
  assert.equal(host.status, 'stopped');
  assert.equal(child.killed, true);
});

test('starts an archived runtime with its module loader and fixed archive environment', async () => {
  let invocation;
  const child = new FakeChild();
  const host = new DshHost({
    entryPath: 'C:/app/resources/dsh-runtime.asar/node_modules/@deepseek-ai/dsh/lib/bin.js',
    moduleLoaderPath: 'C:/app/resources/app.asar/lib/runtime-loader-register.js',
    runtimeArchivePath: 'C:/app/resources/dsh-runtime.asar',
    spawnImpl: (...args) => { invocation = args; return child; },
    platform: 'linux',
    timeoutMs: 1000,
  });

  const starting = host.start('C:/workspace');
  child.stdout.emit('data', 'dsh web: http://127.0.0.1:4123\n');
  assert.equal(await starting, 'http://127.0.0.1:4123');
  assert.deepEqual(invocation[1].slice(0, 4), [
    '--expose-internals',
    '--import',
    'file:///C:/app/resources/app.asar/lib/runtime-loader-register.js',
    'C:/app/resources/dsh-runtime.asar/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]);
  assert.equal(invocation[2].env.DSH_DESKTOP_RUNTIME_ARCHIVE, 'C:/app/resources/dsh-runtime.asar');
  assert.equal(
    invocation[2].env.NODE_PATH.split(path.delimiter)[0],
    path.join('C:/app/resources/dsh-runtime.asar', 'node_modules'),
  );
  await host.stop();
});

test('requires archived runtime loader options as a pair', () => {
  assert.throws(
    () => new DshHost({ entryPath: 'dsh.js', moduleLoaderPath: 'loader.js' }),
    /moduleLoaderPath and runtimeArchivePath together/,
  );
});

test('rejects when the child exits before readiness and retains bounded diagnostics', async () => {
  const child = new FakeChild();
  const host = new DshHost({
    entryPath: 'dsh.js',
    spawnImpl: () => child,
    timeoutMs: 1000,
    maxLogBytes: 32,
  });
  const starting = host.start('C:/workspace');
  child.stderr.emit('data', 'x'.repeat(100));
  child.exitCode = 2;
  child.emit('exit', 2, null);
  await assert.rejects(starting, (error) => {
    assert.ok(error instanceof DshHostError);
    assert.equal(error.code, 'ChildExited');
    assert.equal(error.stderr.length <= 32, true);
    return true;
  });
  assert.equal(host.status, 'stopped');
});

test('times out without polling a fixed port and terminates the child', async () => {
  const child = new FakeChild();
  const host = new DshHost({
    entryPath: 'dsh.js',
    spawnImpl: () => child,
    platform: 'linux',
    timeoutMs: 10,
    terminateTimeoutMs: 10,
  });
  await assert.rejects(host.start('C:/workspace'), { code: 'StartupTimeout' });
  await host.stop();
  assert.equal(child.killed, true);
  assert.equal(host.status, 'stopped');
});

test('rejects navigation to another origin or non-http protocol', () => {
  assert.equal(isAllowedNavigation('http://127.0.0.1:4123/api', 'http://127.0.0.1:4123'), true);
  assert.equal(isAllowedNavigation('http://127.0.0.1:4124/', 'http://127.0.0.1:4123'), false);
  assert.equal(isAllowedNavigation('https://127.0.0.1:4123/', 'http://127.0.0.1:4123'), false);
  assert.equal(isAllowedNavigation('file:///tmp/index.html', 'http://127.0.0.1:4123'), false);
});

test('guards main-frame and subframe navigation with Electron 39 event details', () => {
  const webContents = new EventEmitter();
  let openHandler;
  let permissionHandler;
  webContents.setWindowOpenHandler = (handler) => { openHandler = handler; };
  webContents.session = {
    setPermissionRequestHandler: (handler) => { permissionHandler = handler; },
  };
  installNavigationGuards({ webContents }, () => 'http://127.0.0.1:4123');

  let prevented = false;
  webContents.emit('will-frame-navigate', {
    url: 'https://example.com/',
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.deepEqual(openHandler({ url: 'http://127.0.0.1:4123/' }), { action: 'deny' });
  permissionHandler(null, 'notifications', (allowed) => assert.equal(allowed, false));
});
