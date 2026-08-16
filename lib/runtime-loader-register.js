import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const archivePath = process.env.DSH_DESKTOP_RUNTIME_ARCHIVE;
if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath)) {
  throw new Error('DSH_DESKTOP_RUNTIME_ARCHIVE must name the packaged runtime archive.');
}

const archiveURL = `${pathToFileURL(archivePath).href}/`;
register('./runtime-loader.js', import.meta.url, {
  data: {
    runtimeParentURL: new URL('runtime-host.js', archiveURL).href,
    physicalPackagePrefixes: [
      '@deepseek-ai/node-addon-landlock-run',
      '@vscode/ripgrep',
      'node-pty',
    ],
  },
});
