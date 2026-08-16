'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');

const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)(\..*)?$/i;

function assertFile(root, relativePath) {
  const target = path.join(root, relativePath);
  if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Packaged runtime file is missing: ${relativePath}`);
  }
}

function findFiles(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const matches = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && predicate(target)) matches.push(target);
    }
  }
  return matches;
}

function collectPackageRoots(nodeModulesRoot) {
  const packages = [];
  const visitPackage = (packageRoot) => {
    if (!fs.statSync(path.join(packageRoot, 'package.json'), { throwIfNoEntry: false })?.isFile()) return;
    packages.push(packageRoot);
    visitNodeModules(path.join(packageRoot, 'node_modules'));
  };
  const visitNodeModules = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const target = path.join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(target, { withFileTypes: true })) {
          if (scoped.isDirectory()) visitPackage(path.join(target, scoped.name));
        }
      } else {
        visitPackage(target);
      }
    }
  };
  visitNodeModules(nodeModulesRoot);
  return packages;
}

function resolveInstalledPackage(packageRoot, packageName, boundary) {
  let cursor = packageRoot;
  while (true) {
    const candidate = path.join(cursor, 'node_modules', ...packageName.split('/'), 'package.json');
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    if (cursor === boundary) return null;
    const parent = path.dirname(cursor);
    if (parent === cursor || path.relative(boundary, parent).startsWith('..')) return null;
    cursor = parent;
  }
}

function assertDependencyClosure(nodeModulesRoot) {
  const missing = [];
  const boundary = path.dirname(nodeModulesRoot);
  for (const packageRoot of collectPackageRoots(nodeModulesRoot)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const required = new Set(Object.keys(manifest.dependencies ?? {}));
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!manifest.peerDependenciesMeta?.[peer]?.optional) required.add(peer);
    }
    for (const dependency of required) {
      if (!resolveInstalledPackage(packageRoot, dependency, boundary)) {
        missing.push(`${manifest.name ?? packageRoot} -> ${dependency}`);
      }
    }
  }
  if (missing.length) {
    throw new Error(`Packaged runtime dependency closure is incomplete:\n${missing.sort().join('\n')}`);
  }
}

function generateThirdPartyNotices(nodeModulesRoot, outputPath) {
  const records = collectPackageRoots(nodeModulesRoot).map((packageRoot) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const declaredLicense = typeof manifest.license === 'string'
      ? manifest.license
      : JSON.stringify(manifest.license ?? manifest.licenses ?? 'UNSPECIFIED');
    const licenseFiles = fs.readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LICENSE_FILE_RE.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        text: fs.readFileSync(path.join(packageRoot, entry.name), 'utf8'),
      }));
    return {
      id: `${manifest.name ?? path.basename(packageRoot)}@${manifest.version ?? 'unknown'}`,
      declaredLicense,
      licenseFiles,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const sections = records.map((record) => {
    const texts = record.licenseFiles.length
      ? record.licenseFiles.map((file) => `--- ${file.name} ---\n${file.text.trim()}`).join('\n\n')
      : '[No license/notice file was included at this package root.]';
    return `================================================================================\n${record.id}\nDeclared license: ${record.declaredLicense}\n================================================================================\n${texts}`;
  });
  const header = [
    'DSH Desktop — Third-Party Runtime Notices',
    '',
    'Generated from the production node_modules included in this exact package.',
    'Electron and Chromium notices are shipped separately as LICENSE.electron.txt',
    'and LICENSES.chromium.html in the application directory.',
    '',
  ].join('\n');
  fs.writeFileSync(outputPath, `${header}${sections.join('\n\n')}\n`, 'utf8');
  return records.length;
}

function assertTargetRuntime(unpackedRoot, platform, arch) {
  assertFile(unpackedRoot, path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  assertFile(unpackedRoot, path.join('node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'));

  const ptyRoot = path.join(unpackedRoot, 'node_modules', 'node-pty');
  if (platform === 'win32' || platform === 'darwin') {
    const prebuild = path.join('node_modules', 'node-pty', 'prebuilds', `${platform}-${arch}`);
    assertFile(unpackedRoot, path.join(prebuild, 'pty.node'));
    assertFile(unpackedRoot, path.join(prebuild, platform === 'win32' ? 'winpty-agent.exe' : 'spawn-helper'));
  } else if (platform === 'linux') {
    const linuxPty = findFiles(ptyRoot, (target) => path.basename(target) === 'pty.node');
    const linuxHelper = findFiles(ptyRoot, (target) => path.basename(target) === 'spawn-helper');
    if (!linuxPty.length || !linuxHelper.length) {
      throw new Error('The Linux package is missing the node-pty native module or spawn-helper. Build node-pty during npm install.');
    }
  } else {
    throw new Error(`Unsupported packaging platform: ${platform}`);
  }

  const koffiRoot = path.join(unpackedRoot, 'node_modules', '@koromix', `koffi-${platform}-${arch}`);
  if (!findFiles(koffiRoot, (target) => path.basename(target) === 'koffi.node').length) {
    throw new Error(`The ${platform}-${arch} Koffi native module is missing from the packaged runtime.`);
  }

  if (!findFiles(path.join(unpackedRoot, 'node_modules'), (target) => path.extname(target) === '.node').length) {
    throw new Error('The packaged runtime contains no native .node modules.');
  }
}

async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  if (!arch) throw new Error(`Unknown electron-builder architecture: ${context.arch}`);
  const runtimeRoot = path.join(context.appOutDir, 'resources', 'dsh-runtime');
  assertDependencyClosure(path.join(runtimeRoot, 'node_modules'));
  assertTargetRuntime(runtimeRoot, platform, arch);
  const noticePath = path.join(context.appOutDir, 'THIRD_PARTY_NOTICES.txt');
  const packageCount = generateThirdPartyNotices(path.join(runtimeRoot, 'node_modules'), noticePath);
  if (!packageCount) throw new Error('No runtime packages were found while generating third-party notices.');
}

module.exports = afterPack;
module.exports.assertDependencyClosure = assertDependencyClosure;
module.exports.assertTargetRuntime = assertTargetRuntime;
module.exports.generateThirdPartyNotices = generateThirdPartyNotices;
