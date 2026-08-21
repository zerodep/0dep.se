import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const distDir = join(repoRoot, 'dist');

let manifest;

before(async () => {
  const { build } = await import('../src/build.js');
  await build();
  manifest = JSON.parse(await readFile(join(repoRoot, 'data', 'projects.json'), 'utf8'));
});

test('llms.txt summarises the site for AI crawlers', async () => {
  const llms = await readFile(join(distDir, 'llms.txt'), 'utf8');
  assert.match(llms, /^# zerodep/, 'should start with an H1 title');
  assert.match(llms, /^> /m, 'should carry a blockquote summary');
  const base = `https://${manifest.site.primaryDomain}`;
  for (const path of ['/run/', '/dmn/', '/about/']) {
    assert.ok(llms.includes(`${base}${path}`), `should link ${path}`);
  }
  assert.match(llms, /bpmn-engine/, 'should mention the packages');
  assert.match(llms, /dmn-elements/, 'should mention dmn-elements');
});

test('IndexNow key file is deployed at the site root', async () => {
  const statics = await readdir(join(repoRoot, 'static'));
  const keyFile = statics.find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  assert.ok(keyFile, 'static/ should hold a 32-hex IndexNow key file');
  const key = (await readFile(join(distDir, keyFile), 'utf8')).trim();
  assert.equal(key, keyFile.replace(/\.txt$/, ''), 'key file content must equal the key');
});

test('deploy workflow pings IndexNow after deploying', async () => {
  const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'pages.yaml'), 'utf8').catch(async () => {
    const files = await readdir(join(repoRoot, '.github', 'workflows'));
    return readFile(join(repoRoot, '.github', 'workflows', files[0]), 'utf8');
  });
  assert.match(workflow, /api\.indexnow\.org/, 'workflow should ping IndexNow');
  assert.match(workflow, /\/dmn\//, 'ping should list the dmn page');
});
