'use strict';

const manifest = require('../package.json');

function validateReleaseTag(tag, version = manifest.version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Application releases must use a stable semantic version, received ${version}.`);
  }
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag ${JSON.stringify(tag)} does not match package version ${JSON.stringify(expected)}.`);
  }
  return expected;
}

if (require.main === module) {
  const tag = process.env.GITHUB_REF_NAME || process.argv[2];
  if (!tag) throw new Error('Set GITHUB_REF_NAME or pass the release tag as the first argument.');
  process.stdout.write(`Validated release ${validateReleaseTag(tag)}\n`);
}

module.exports = { validateReleaseTag };
