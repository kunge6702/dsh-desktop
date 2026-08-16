const INITIAL_CHECK_DELAY_MS = 10_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class UpdateController {
  constructor({
    updater,
    dialog,
    isPackaged,
    currentVersion,
    getWindow = () => null,
    prepareToInstall = async () => {},
    onStateChange = () => {},
    logger = console,
    schedule = setTimeout,
  }) {
    this.updater = updater;
    this.dialog = dialog;
    this.isPackaged = isPackaged;
    this.currentVersion = currentVersion;
    this.getWindow = getWindow;
    this.prepareToInstall = prepareToInstall;
    this.onStateChange = onStateChange;
    this.logger = logger;
    this.schedule = schedule;
    this.state = { name: 'idle' };
    this.checkPromise = null;
    this.initialCheckScheduled = false;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.on?.('download-progress', (progress) => {
      this.#setState({ name: 'downloading', percent: Math.round(progress.percent ?? 0) });
    });
    updater.on?.('error', (error) => {
      logger.error?.(`[update] ${errorMessage(error)}`);
    });
  }

  #setState(state) {
    this.state = state;
    this.onStateChange(state);
  }

  async #showMessage(options) {
    const window = this.getWindow();
    return window && !window.isDestroyed?.()
      ? this.dialog.showMessageBox(window, options)
      : this.dialog.showMessageBox(options);
  }

  scheduleInitialCheck(delayMs = INITIAL_CHECK_DELAY_MS) {
    if (!this.isPackaged || this.initialCheckScheduled) return;
    this.initialCheckScheduled = true;
    const timer = this.schedule(() => { void this.check({ manual: false }); }, delayMs);
    timer?.unref?.();
  }

  check({ manual = true } = {}) {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.#check(manual).finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  async #check(manual) {
    if (!this.isPackaged) {
      if (manual) {
        await this.#showMessage({
          type: 'info',
          title: '检查更新',
          message: '开发版本不检查更新',
          detail: '请安装正式发布的 DSH Desktop 后再检查更新。',
        });
      }
      return { status: 'disabled' };
    }

    if (this.state.name === 'downloaded') {
      await this.#promptToInstall(this.state.version);
      return { status: 'downloaded', version: this.state.version };
    }

    this.#setState({ name: 'checking' });
    try {
      const result = await this.updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        this.#setState({ name: 'idle' });
        if (manual) {
          await this.#showMessage({
            type: 'info',
            title: '检查更新',
            message: '当前已是最新版本',
            detail: `DSH Desktop ${this.currentVersion}`,
          });
        }
        return { status: 'current' };
      }

      const version = result.updateInfo.version;
      this.#setState({ name: 'available', version });
      const choice = await this.#showMessage({
        type: 'info',
        title: '发现新版本',
        message: `DSH Desktop ${version} 可用`,
        detail: `当前版本：${this.currentVersion}\n是否现在下载更新？`,
        buttons: ['下载更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response !== 0) {
        this.#setState({ name: 'idle' });
        return { status: 'deferred', version };
      }

      this.#setState({ name: 'downloading', percent: 0, version });
      await this.updater.downloadUpdate();
      this.#setState({ name: 'downloaded', version });
      await this.#promptToInstall(version);
      return { status: 'downloaded', version };
    } catch (error) {
      this.#setState({ name: 'idle' });
      this.logger.error?.(`[update] ${errorMessage(error)}`);
      if (manual) {
        await this.#showMessage({
          type: 'error',
          title: '检查更新失败',
          message: '暂时无法检查更新',
          detail: errorMessage(error),
        });
      }
      return { status: 'error', error };
    }
  }

  async #promptToInstall(version) {
    const choice = await this.#showMessage({
      type: 'info',
      title: '更新已下载',
      message: `DSH Desktop ${version} 已准备好`,
      detail: '可以立即重启安装，也可以在退出应用时自动安装。',
      buttons: ['立即重启安装', '退出时安装'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return;
    await this.prepareToInstall();
    this.updater.quitAndInstall(false, true);
  }
}

export { INITIAL_CHECK_DELAY_MS };
