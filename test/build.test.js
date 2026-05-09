import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const distDir = join(repoRoot, 'dist');

let html;
let manifest;

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => escapeMap[c]);

before(async () => {
  await rm(distDir, { recursive: true, force: true });
  const { build } = await import('../src/build.js');
  await build();
  html = await readFile(join(distDir, 'index.html'), 'utf8');
  manifest = JSON.parse(await readFile(join(repoRoot, 'data', 'projects.json'), 'utf8'));
});

test('writes index.html', async () => {
  const s = await stat(join(distDir, 'index.html'));
  assert.ok(s.isFile());
});

test('writes styles.css', async () => {
  const s = await stat(join(distDir, 'styles.css'));
  assert.ok(s.isFile());
});

test('writes CNAME with primary domain', async () => {
  const cname = (await readFile(join(distDir, 'CNAME'), 'utf8')).trim();
  assert.equal(cname, manifest.site.primaryDomain);
});

test('copies brand assets to dist', async () => {
  for (const f of ['logo.png', 'favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png']) {
    const s = await stat(join(distDir, f));
    assert.ok(s.isFile(), `missing asset: ${f}`);
  }
});

test('html references favicon and apple touch icon', () => {
  assert.match(html, /<link[^>]+rel="icon"[^>]+favicon-32\.png/);
  assert.match(html, /<link[^>]+rel="icon"[^>]+favicon-192\.png/);
  assert.match(html, /<link[^>]+rel="apple-touch-icon"[^>]+apple-touch-icon\.png/);
});

test('html uses the logo image in the header', () => {
  assert.match(html, /<img[^>]+src="logo\.png"[^>]+alt="zerodep"/);
});

test('html starts with doctype', () => {
  assert.match(html.slice(0, 20).toLowerCase(), /^<!doctype html>/);
});

test('html has lang and meta charset/viewport', () => {
  assert.match(html, /<html[^>]+lang="/);
  assert.match(html, /<meta[^>]+charset="utf-8"/i);
  assert.match(html, /<meta[^>]+name="viewport"/i);
});

test('html sets the site title and tagline', () => {
  assert.ok(html.includes(escape(manifest.site.title)));
  assert.ok(html.includes(escape(manifest.site.tagline)));
});

test('html mentions every project name and description', () => {
  for (const group of manifest.groups) {
    assert.ok(html.includes(escape(group.title)), `group title missing: ${group.title}`);
    for (const p of group.projects) {
      assert.ok(html.includes(escape(p.name)), `project name missing: ${p.name}`);
      assert.ok(
        html.includes(escape(p.description)),
        `project description missing: ${p.slug}`,
      );
      assert.ok(html.includes(p.repo), `repo link missing: ${p.slug}`);
    }
  }
});

test('html has no unrendered template placeholders', () => {
  assert.doesNotMatch(html, /\{\{[^}]+\}\}/, 'unrendered {{placeholder}} found');
});

test('html escapes user-controlled strings', () => {
  assert.doesNotMatch(html, /<script(?![^>]*type="application\/ld\+json")[^>]*>/);
});
