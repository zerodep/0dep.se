import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', 'data', 'projects.json');

let manifest;
test('manifest loads as JSON', async () => {
  const raw = await readFile(manifestPath, 'utf8');
  manifest = JSON.parse(raw);
  assert.equal(typeof manifest, 'object');
});

test('manifest has site metadata', () => {
  assert.equal(typeof manifest.site, 'object');
  assert.equal(typeof manifest.site.title, 'string');
  assert.equal(typeof manifest.site.tagline, 'string');
  assert.equal(typeof manifest.site.primaryDomain, 'string');
  assert.ok(manifest.site.primaryDomain.length > 0, 'primaryDomain non-empty');
});

test('manifest has groups with projects', () => {
  assert.ok(Array.isArray(manifest.groups));
  assert.ok(manifest.groups.length >= 2, 'expect zerodep + bpmn-engine groups');
  for (const group of manifest.groups) {
    assert.equal(typeof group.id, 'string');
    assert.equal(typeof group.title, 'string');
    assert.equal(typeof group.description, 'string');
    assert.ok(Array.isArray(group.projects));
    assert.ok(group.projects.length > 0, `group ${group.id} has projects`);
  }
});

test('every project has required fields', () => {
  const slugs = new Set();
  for (const group of manifest.groups) {
    for (const p of group.projects) {
      assert.equal(typeof p.slug, 'string', `slug missing in ${group.id}`);
      assert.match(p.slug, /^[a-z0-9-]+$/, `slug must be kebab-case: ${p.slug}`);
      assert.ok(!slugs.has(p.slug), `duplicate slug: ${p.slug}`);
      slugs.add(p.slug);

      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.description, 'string');
      assert.ok(p.description.length >= 20, `description too short: ${p.slug}`);

      assert.equal(typeof p.repo, 'string');
      assert.match(p.repo, /^https:\/\/github\.com\//, `repo must be https github URL: ${p.slug}`);

      assert.ok(Array.isArray(p.tags), `tags array required: ${p.slug}`);
      assert.ok(p.tags.length > 0, `at least one tag: ${p.slug}`);

      if (p.npm !== undefined) {
        assert.equal(typeof p.npm, 'string');
        assert.ok(p.npm.length > 0);
      }
    }
  }
});

test('expected zerodep packages are present', () => {
  const allSlugs = new Set(manifest.groups.flatMap((g) => g.projects.map((p) => p.slug)));
  for (const expected of [
    'piso',
    'bpmn-middleware',
    'pino-applicationinsights',
    'ocrgenerator',
    'texample',
    'bpmn-engine',
  ]) {
    assert.ok(allSlugs.has(expected), `expected project missing: ${expected}`);
  }
});
