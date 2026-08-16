'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const asar = require('@electron/asar');

const RUNTIME_ARCHIVE_NAME = 'dsh-runtime.asar';
const RUNTIME_UNPACK_PATTERN = '**/*.{node,exe}';
const RUNTIME_UNPACKED_DIRECTORIES = [
  'node_modules/node-pty',
  'node_modules/@vscode/ripgrep',
  'node_modules/@vscode/ripgrep-*',
  'node_modules/@deepseek-ai/node-addon-landlock-run',
  'node_modules/@deepseek-ai/node-addon-landlock-run-*',
];

async function beforePack() {
  const runtimeDirectory = path.resolve(__dirname, '..', 'runtime');
  const archiveDirectory = path.resolve(__dirname, '..', 'runtime-archive');
  const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCli = process.env.npm_execpath || (fs.existsSync(bundledNpmCli) ? bundledNpmCli : null);
  if (!npmCli) throw new Error('Cannot locate npm-cli.js. Run packaging through `npm run dist`.');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: runtimeDirectory,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Runtime npm ci failed (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`));
    });
  });

  fs.rmSync(archiveDirectory, { recursive: true, force: true });
  fs.mkdirSync(archiveDirectory, { recursive: true });
  await asar.createPackageWithOptions(
    runtimeDirectory,
    path.join(archiveDirectory, RUNTIME_ARCHIVE_NAME),
    {
      unpack: RUNTIME_UNPACK_PATTERN,
      unpackDir: `{${RUNTIME_UNPACKED_DIRECTORIES.join(',')}}`,
    },
  );
}

module.exports = beforePack;
module.exports.RUNTIME_ARCHIVE_NAME = RUNTIME_ARCHIVE_NAME;
module.exports.RUNTIME_UNPACK_PATTERN = RUNTIME_UNPACK_PATTERN;
module.exports.RUNTIME_UNPACKED_DIRECTORIES = RUNTIME_UNPACKED_DIRECTORIES;
