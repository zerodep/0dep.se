import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const distDir = join(repoRoot, 'dist');

const parseHtml = (html) => {
  const { DOMParser } = new Window();
  return new DOMParser().parseFromString(html, 'text/html');
};

let doc;
let manifest;

before(async () => {
  await rm(distDir, { recursive: true, force: true });
  const { build } = await import('../src/build.js');
  await build();
  doc = parseHtml(await readFile(join(distDir, 'tools', 'index.html'), 'utf8'));
  manifest = JSON.parse(await readFile(join(repoRoot, 'data', 'projects.json'), 'utf8'));
});

test('writes tools/index.html', async () => {
  assert.ok((await stat(join(distDir, 'tools', 'index.html'))).isFile());
});

test('tools page has an ISO 8601 form with input, kind picker and UTC toggle', () => {
  const form = doc.querySelector('form#iso-form');
  assert.ok(form, 'iso form not found');
  assert.ok(form.querySelector('input#iso-input'), 'iso input not found');
  const kind = form.querySelector('select#iso-kind');
  assert.ok(kind, 'iso kind select not found');
  const values = [...kind.querySelectorAll('option')].map((o) => o.getAttribute('value'));
  assert.deepEqual(values, ['auto', 'interval', 'duration', 'date']);
  assert.ok(form.querySelector('input#iso-utc[type="checkbox"]'), 'utc checkbox not found');
  assert.equal(form.querySelector('button[type="submit"]')?.textContent.trim(), 'Parse');
  assert.ok(doc.querySelector('#iso-result'), 'iso result container not found');
});

test('tools page has an OCR form with mode, length options and result', () => {
  const form = doc.querySelector('form#ocr-form');
  assert.ok(form, 'ocr form not found');
  assert.ok(form.querySelector('input#ocr-input'), 'ocr input not found');
  const modes = [...form.querySelectorAll('input[name="ocr-mode"]')].map((r) => r.getAttribute('value'));
  assert.deepEqual(modes.sort(), ['generate', 'validate']);
  assert.ok(form.querySelector('input#ocr-fixed'), 'fixed length input not found');
  assert.ok(form.querySelector('input#ocr-fixed2'), 'second fixed length input not found');
  assert.ok(form.querySelector('input#ocr-min'), 'min length input not found');
  assert.ok(form.querySelector('input#ocr-max'), 'max length input not found');
  assert.ok(doc.querySelector('#ocr-result'), 'ocr result container not found');
});

test('tools page has a history section with a list and a clear button', () => {
  const history = doc.querySelector('section#history');
  assert.ok(history, 'history section not found');
  assert.ok(history.querySelector('ol#history-list'), 'history list not found');
  assert.ok(history.querySelector('button#history-clear'), 'clear button not found');
  assert.match(history.textContent.toLowerCase(), /browser/, 'should explain history stays in the browser');
});

test('tools page loads the bundled app as a module', () => {
  const script = doc.querySelector('script[type="module"]');
  assert.equal(script?.getAttribute('src'), '/tools/app.js');
});

test('bundles tools/app.js for the browser', async () => {
  const bundle = await readFile(join(distDir, 'tools', 'app.js'), 'utf8');
  assert.ok(bundle.length > 5_000, 'bundle suspiciously small');
  assert.ok(!/["']node:[a-z/]+["']/.test(bundle), 'bundle references node built-ins');
  assert.match(bundle, /serviceWorker/, 'app should register the service worker');
});

test('tools page sets a same-origin content security policy', () => {
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
});

test('tools page title and description target the two libraries', () => {
  assert.match(doc.title, /ISO 8601/);
  assert.match(doc.title, /OCR/);
  const desc = doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  assert.match(desc.toLowerCase(), /browser/);
  assert.match(desc.toLowerCase(), /bankgiro/);
  const keywords = doc.querySelector('meta[name="keywords"]')?.getAttribute('content') ?? '';
  for (const phrase of ['iso 8601 duration', 'iso 8601 interval', 'ocr', 'bankgiro', 'modulus 10']) {
    assert.ok(keywords.toLowerCase().includes(phrase), `keywords should include ${phrase}`);
  }
});

test('tools page has crawlable about content, FAQ JSON-LD and source link', () => {
  const about = doc.querySelector('section.run-about');
  assert.ok(about, 'about section not found');
  assert.match(about.textContent.toLowerCase(), /never leave/i);
  assert.match(about.textContent.toLowerCase(), /offline/);
  assert.ok(about.querySelector('a[href="https://github.com/zerodep/piso"]'), 'should link piso');
  assert.ok(about.querySelector('a[href="https://github.com/zerodep/ocrgenerator"]'), 'should link ocrgenerator');
  assert.ok(about.querySelector('a[href="https://github.com/zerodep/0dep.se"]'), 'should link site source');

  const types = new Set();
  const faqs = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const data = JSON.parse(s.textContent);
    for (const item of Array.isArray(data) ? data : [data]) {
      types.add(item['@type']);
      if (item['@type'] === 'FAQPage') faqs.push(...item.mainEntity);
    }
  }
  assert.ok(types.has('WebApplication'));
  assert.ok(types.has('FAQPage'));
  assert.ok(faqs.length >= 3);
  for (const q of faqs) assert.ok(about.textContent.includes(q.name), `FAQ visible: ${q.name}`);
});

test('tools page works offline — own service worker with tools- cache prefix', async () => {
  const sw = await readFile(join(distDir, 'tools', 'sw.js'), 'utf8');
  assert.match(sw, /tools-[0-9a-f]+/);
  assert.ok(sw.includes(`key.startsWith('tools-')`));
  for (const asset of ['/tools/', '/tools/index.html', '/tools/app.js', '/styles.css']) {
    assert.ok(sw.includes(`"${asset}"`), `should precache ${asset}`);
  }
});

test('tools page canonical link is /tools/', () => {
  assert.equal(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'), `https://${manifest.site.primaryDomain}/tools/`);
});

test('home nav, sitemap and llms.txt list /tools/', async () => {
  const homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  assert.ok(homeDoc.querySelector('nav a[href="/tools/"]'), 'tools link in nav not found');
  const sitemap = await readFile(join(distDir, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.split('<url>').some((u) => u.includes('/tools/</loc>')), 'sitemap should list /tools/');
  const llms = await readFile(join(distDir, 'llms.txt'), 'utf8');
  assert.match(llms, /\/tools\/\)/);
});

test('home piso and ocrgenerator cards link to the tools page', async () => {
  const homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  for (const slug of ['piso', 'ocrgenerator']) {
    const card = homeDoc.querySelector(`article.project#${slug}`);
    assert.ok(card, `${slug} card not found`);
    assert.ok(card.querySelector('.links a[href^="/tools/"]'), `${slug} card should link to /tools/`);
  }
});

test('tools page links back to the runners', () => {
  assert.ok(doc.querySelector('a[href="/run/"]'));
  assert.ok(doc.querySelector('a[href="/dmn/"]'));
});
