import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

const ANSI_ESCAPE_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const READY_LINE_RE = /^dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+))\s*$/i;

export class DshHostError extends Error {
  constructor(message, code = 'DshHostError', details = {}) {
    super(message);
    this.name = 'DshHostError';
    this.code = code;
    Object.assign(this, details);
  }
}

function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE_RE, '');
}

function appendBounded(current, value, maxBytes) {
  const next = `${current}${value}`;
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) return next;
  return next.slice(-maxBytes);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    child.once('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

/**
 * Supervises the DSH web child process. The child remains connected to its
 * stdout/stderr for its whole lifetime so a verbose session cannot deadlock
 * on a full pipe.
 */
export class DshHost extends EventEmitter {
  constructor({
    entryPath,
    executable = process.execPath,
    spawnImpl = nodeSpawn,
    execFileImpl = execFile,
    platform = process.platform,
    timeoutMs = 30_000,
    terminateTimeoutMs = 3_000,
    maxLogBytes = 128 * 1024,
    logger = () => {},
  } = {}) {
    super();
    if (!entryPath) throw new TypeError('DshHost requires entryPath');
    this.entryPath = entryPath;
    this.executable = executable;
    this.spawnImpl = spawnImpl;
    this.execFileImpl = execFileImpl;
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.terminateTimeoutMs = terminateTimeoutMs;
    this.maxLogBytes = maxLogBytes;
    this.logger = logger;
    this.status = 'stopped';
    this.child = null;
    this.url = null;
    this.workspace = null;
    this.stdoutLog = '';
    this.stderrLog = '';
    this._readinessBuffer = '';
    this._startPromise = null;
    this._startup = null;
    this._stopPromise = null;
  }

  async start(workspace) {
    if (!path.isAbsolute(workspace)) {
      throw new DshHostError('The DSH workspace must be an absolute path.', 'InvalidWorkspace');
    }
    if (this.status === 'ready' && this.url && this.workspace === workspace) return this.url;
    if (this.status === 'starting' && this._startPromise) return this._startPromise;
    if (this.status === 'stopping' || this._stopPromise) {
      await this._stopPromise;
    }
    if (this.child) await this.stop();

    const startPromise = this.#startInternal(workspace);
    this._startPromise = startPromise;
    startPromise.then(
      () => { if (this._startPromise === startPromise) this._startPromise = null; },
      () => { if (this._startPromise === startPromise) this._startPromise = null; },
    );
    return startPromise;
  }

  #startInternal(workspace) {
    this.status = 'starting';
    this.workspace = workspace;
    this.url = null;
    this.stdoutLog = '';
    this.stderrLog = '';
    this._readinessBuffer = '';

    let child;
    try {
      child = this.spawnImpl(this.executable, [
        '--expose-internals',
        this.entryPath,
        'web',
        '--host', '127.0.0.1',
        '--port', '0',
      ], {
        cwd: workspace,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.status = 'stopped';
      throw new DshHostError(`Failed to spawn DSH: ${error.message}`, 'SpawnFailed', { cause: error });
    }

    this.child = child;
    const startup = {};
    this._startup = startup;

    const settle = (kind, value) => {
      if (startup.settled) return;
      startup.settled = true;
      clearTimeout(startup.timer);
      this._startup = null;
      if (kind === 'resolve') {
        this.status = 'ready';
        this.url = value;
        this.emit('ready', { url: value, workspace });
        startup.resolve(value);
      } else {
        this.status = 'stopped';
        startup.reject(value);
      }
    };

    const onData = (stream, data) => {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (stream === 'stdout') {
        this.stdoutLog = appendBounded(this.stdoutLog, text, this.maxLogBytes);
        this._readinessBuffer = appendBounded(this._readinessBuffer, stripAnsi(text), this.maxLogBytes);
        const lines = this._readinessBuffer.split(/\r?\n/);
        // DSH prints a newline after the readiness line. Ignore a partial last
        // line so a chunk boundary cannot make us accept a truncated port.
        for (const line of lines.slice(0, -1)) {
          const match = line.trim().match(READY_LINE_RE);
          if (!match) continue;
          const port = Number(match[2]);
          if (port >= 1 && port <= 65_535) {
            settle('resolve', match[1]);
            break;
          }
        }
        this.logger('stdout', text);
      } else {
        this.stderrLog = appendBounded(this.stderrLog, text, this.maxLogBytes);
        this.logger('stderr', text);
      }
    };

    child.stdout?.on('data', (data) => onData('stdout', data));
    child.stderr?.on('data', (data) => onData('stderr', data));

    child.once('error', (error) => {
      const afterReady = startup.settled && this.status === 'ready';
      const wrapped = new DshHostError(`DSH process error: ${error.message}`, 'ChildError', {
        cause: error,
        stdout: this.stdoutLog,
        stderr: this.stderrLog,
      });
      if (!startup.settled) settle('reject', wrapped);
      if (afterReady) this.emit('child-error', wrapped);
    });

    child.on('exit', (code, signal) => {
      const intentional = this.status === 'stopping' || Boolean(this._stopPromise);
      if (!startup.settled) {
        settle('reject', new DshHostError(
          `DSH exited before becoming ready (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`,
          'ChildExited',
          { exitCode: code, signal, stdout: this.stdoutLog, stderr: this.stderrLog },
        ));
      }
      if (this.child === child) {
        this.child = null;
        this.url = null;
        this.status = 'stopped';
      }
      this.emit('exit', { code, signal, intentional, stdout: this.stdoutLog, stderr: this.stderrLog });
    });

    startup.settled = false;
    startup.timer = setTimeout(() => {
      settle('reject', new DshHostError(
        `Timed out waiting for DSH readiness after ${this.timeoutMs} ms.`,
        'StartupTimeout',
        { stdout: this.stdoutLog, stderr: this.stderrLog },
      ));
      void this.stop();
    }, this.timeoutMs);
    startup.promise = new Promise((resolve, reject) => {
      startup.resolve = resolve;
      startup.reject = reject;
    });
    return startup.promise;
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;
    const child = this.child;
    if (!child) {
      this.status = 'stopped';
      this.url = null;
      return;
    }

    this.status = 'stopping';
    if (this._startup && !this._startup.settled) {
      this._startup.settled = true;
      clearTimeout(this._startup.timer);
      this._startup.reject(new DshHostError('DSH startup was cancelled.', 'StartupCancelled'));
      this._startup = null;
    }

    this._stopPromise = (async () => {
      try {
        await this.#terminate(child);
        const exited = await waitForExit(child, this.terminateTimeoutMs);
        if (!exited) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          await waitForExit(child, this.terminateTimeoutMs);
        }
      } finally {
        if (this.child === child) this.child = null;
        this.url = null;
        this.status = 'stopped';
        this._stopPromise = null;
      }
    })();
    return this._stopPromise;
  }

  async #terminate(child) {
    if (this.platform === 'win32' && child.pid) {
      const failed = await new Promise((resolve) => {
        this.execFileImpl(
          'taskkill',
          ['/pid', String(child.pid), '/t', '/f'],
          { windowsHide: true },
          (error) => resolve(Boolean(error)),
        );
      });
      if (failed) {
        try { child.kill(); } catch { /* already gone */ }
      }
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
    const exited = await waitForExit(child, this.terminateTimeoutMs);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  diagnostics() {
    return {
      status: this.status,
      workspace: this.workspace,
      url: this.url,
      stdout: this.stdoutLog,
      stderr: this.stderrLog,
    };
  }
}
