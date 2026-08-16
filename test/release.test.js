import assert from 'node:assert/strict';
import test from 'node:test';
import releaseValidation from '../scripts/validate-release.cjs';

test('release tags must exactly match a stable package version', () => {
  assert.equal(releaseValidation.validateReleaseTag('v0.2.0', '0.2.0'), 'v0.2.0');
  assert.throws(
    () => releaseValidation.validateReleaseTag('v0.2.1', '0.2.0'),
    /does not match package version/,
  );
  assert.throws(
    () => releaseValidation.validateReleaseTag('v0.3.0-beta.1', '0.3.0-beta.1'),
    /stable semantic version/,
  );
});
