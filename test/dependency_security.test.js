import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

function assertPatchedVersions(packageName, minimum) {
  const entries = Object.entries(lock.packages).filter(([location]) =>
    location.endsWith(`node_modules/${packageName}`));
  assert.ok(entries.length > 0, `${packageName} must be present in the dependency lock`);
  for (const [location, entry] of entries) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/, `${location} must use a stable release`);
    const version = entry.version.split('.').map(Number);
    const firstDifference = version.findIndex((part, index) => part !== minimum[index]);
    assert.ok(firstDifference === -1 || version[firstDifference] > minimum[firstDifference],
      `${location}@${entry.version} must be at least ${minimum.join('.')}`);
  }
}

test('body-parser excludes the compressed-request trailing-bytes DoS release range', () => {
  // GHSA-27r3-jxmh-p828: fixed in 1.20.9.
  assertPatchedVersions('body-parser', [1, 20, 9]);
});

test('qs excludes the comma-array stringify DoS release range', () => {
  // GHSA-6pq8-jhm2-2vcw: fixed in 6.16.1.
  assertPatchedVersions('qs', [6, 16, 1]);
});
