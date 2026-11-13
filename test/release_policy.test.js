import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('v2 release publication is version-only and leaves legacy deployment pin unchanged', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/publish-image.yml', import.meta.url), 'utf8');
  const tags = workflow.match(/          tags: \|\n((?:            .*\n)+)/)?.[1].trim();
  assert.equal(tags, '${{ env.IMAGE }}:${{ needs.resolve.outputs.tag }}');
  assert(!workflow.includes('${{ env.IMAGE }}:latest'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '2.0.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8'), /image: &bridge-image ghcr.io\/coke1120\/grok-whatsapp-bridge:v1\.3\.3/);
});
