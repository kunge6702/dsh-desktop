'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

async function beforePack() {
  const runtimeDirectory = path.resolve(__dirname, '..', 'runtime');
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
}

module.exports = beforePack;
