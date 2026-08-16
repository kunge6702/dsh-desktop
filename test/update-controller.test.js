import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { UpdateController } from '../lib/update-controller.js';

class FakeUpdater extends EventEmitter {
  constructor(result) {
    super();
    this.result = result;
    this.downloads = 0;
    this.installs = [];
  }

  async checkForUpdates() {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async downloadUpdate() {
    this.downloads += 1;
    this.emit('download-progress', { percent: 42.4 });
    return ['update.exe'];
  }

  quitAndInstall(...args) {
    this.installs.push(args);
  }
}

function createDialog(responses = []) {
  const calls = [];
  return {
    calls,
    async showMessageBox(...args) {
      calls.push(args.at(-1));
      return responses.shift() ?? { response: 0 };
    },
  };
}

function createController({ updater, dialog, isPackaged = true, prepareToInstall, onStateChange, logger } = {}) {
  return new UpdateController({
    updater,
    dialog,
    isPackaged,
    currentVersion: '0.2.0',
    prepareToInstall,
    onStateChange,
    logger: logger ?? { error() {} },
  });
}

test('manual check reports when the installed release is current', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.2.0' } });
  const dialog = createDialog();
  const controller = createController({ updater, dialog });

  assert.deepEqual(await controller.check(), { status: 'current' });
  assert.equal(dialog.calls[0].message, '当前已是最新版本');
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.disableWebInstaller, true);
});

test('downloads an accepted update and defers installation until exit', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' } });
  const dialog = createDialog([{ response: 0 }, { response: 1 }]);
  const states = [];
  const controller = createController({ updater, dialog, onStateChange: (state) => states.push(state) });

  assert.deepEqual(await controller.check(), { status: 'downloaded', version: '0.3.0' });
  assert.equal(updater.downloads, 1);
  assert.deepEqual(updater.installs, []);
  assert.equal(states.some((state) => state.name === 'downloading' && state.percent === 42), true);
  assert.deepEqual(controller.state, { name: 'downloaded', version: '0.3.0' });
});

test('prepares the application before immediately installing an update', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' } });
  const dialog = createDialog([{ response: 0 }, { response: 0 }]);
  let prepared = 0;
  const controller = createController({
    updater,
    dialog,
    prepareToInstall: async () => { prepared += 1; },
  });

  await controller.check();
  assert.equal(prepared, 1);
  assert.deepEqual(updater.installs, [[false, true]]);
});

test('background check failures are logged without interrupting the user', async () => {
  const updater = new FakeUpdater(new Error('offline'));
  const dialog = createDialog();
  const errors = [];
  const controller = createController({
    updater,
    dialog,
    logger: { error: (message) => errors.push(message) },
  });

  const result = await controller.check({ manual: false });
  assert.equal(result.status, 'error');
  assert.equal(dialog.calls.length, 0);
  assert.equal(errors.some((message) => message.includes('offline')), true);
});

test('development builds never contact the release service', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '9.0.0' } });
  const dialog = createDialog();
  const controller = createController({ updater, dialog, isPackaged: false });

  assert.deepEqual(await controller.check(), { status: 'disabled' });
  assert.equal(dialog.calls[0].message, '开发版本不检查更新');
});
