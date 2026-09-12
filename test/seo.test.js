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

test('sitemap.xml lists the home and about images through the image extension', async () => {
  const sitemap = await readFile(join(distDir, 'sitemap.xml'), 'utf8');
  const profile = JSON.parse(await readFile(join(repoRoot, 'data', 'profile.json'), 'utf8'));
  const base = `https://${manifest.site.primaryDomain}`;
  assert.ok(sitemap.includes('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'), 'image namespace declared');
  const entries = sitemap.split('<url>').slice(1);
  const home = entries.find((u) => u.includes(`<loc>${base}/</loc>`));
  assert.ok(home, 'home entry');
  assert.ok(home.includes(`<image:image>\n      <image:loc>${base}${manifest.site.ogImage}</image:loc>\n    </image:image>`), 'home lists the og image');
  const about = entries.find((u) => u.includes(`<loc>${base}/about/</loc>`));
  assert.ok(about, 'about entry');
  assert.ok(about.includes(`<image:loc>${base}${profile.avatar}</image:loc>`), 'about lists the avatar');
  for (const entry of entries) {
    if (entry === home || entry === about) continue;
    assert.ok(!entry.includes('<image:'), 'pages without images carry no image entries');
  }
});
