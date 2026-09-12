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
  doc = parseHtml(await readFile(join(distDir, 'toc', 'index.html'), 'utf8'));
  manifest = JSON.parse(await readFile(join(repoRoot, 'data', 'projects.json'), 'utf8'));
});

test('writes toc/index.html', async () => {
  assert.ok((await stat(join(distDir, 'toc', 'index.html'))).isFile());
});

test('toc page has a markdown textarea inside a drop zone', () => {
  const zone = doc.querySelector('[data-dropzone]');
  assert.ok(zone, 'drop zone element not found');
  const textarea = zone.querySelector('textarea#source');
  assert.ok(textarea, 'textarea#source not found in the drop zone');
  const label = zone.querySelector('label[for="source"]');
  assert.match(label?.textContent ?? '', /drop/i, 'label should invite a file drop');
  assert.match(label?.textContent ?? '', /\.md/, 'label should name the file type');
});

test('toc page offers generate and example buttons plus wrap options', () => {
  assert.ok(doc.querySelector('button#generate'), 'generate button not found');
  assert.ok(doc.querySelector('button#example'), 'example button not found');
  const wrap = doc.querySelector('select#toc-wrap');
  assert.ok(wrap, 'wrap select not found');
  const values = [...wrap.querySelectorAll('option')].map((o) => o.getAttribute('value'));
  assert.deepEqual(values, ['plain', 'collapsible', 'collapsed']);
  assert.ok(doc.querySelector('input#toc-summary[type="text"]'), 'summary input not found');
});

test('toc page has result areas for the block, the updated document, copy buttons and a download link', () => {
  assert.ok(doc.querySelector('#toc-status'), 'status not found');
  assert.ok(doc.querySelector('ul#toc-pairs'), 'pair list not found');
  assert.ok(doc.querySelector('#toc-block'), 'block output not found');
  assert.ok(doc.querySelector('textarea#output[readonly]'), 'document output not found');
  assert.ok(doc.querySelector('button#copy-block'), 'copy block button not found');
  assert.ok(doc.querySelector('button#copy-output'), 'copy output button not found');
  const download = doc.querySelector('a#download[download]');
  assert.ok(download, 'download link not found');
  assert.ok(download.hasAttribute('hidden'), 'download link starts hidden until there is output');
});

test('toc page loads the bundled app as a module', () => {
  const script = doc.querySelector('script[type="module"]');
  assert.equal(script?.getAttribute('src'), '/toc/app.js');
});

test('bundles toc/app.js for the browser and copies the example', async () => {
  const bundle = await readFile(join(distDir, 'toc', 'app.js'), 'utf8');
  assert.ok(bundle.length > 3_000, 'bundle suspiciously small');
  assert.ok(!/["']node:[a-z/]+["']/.test(bundle), 'bundle references node built-ins');
  assert.match(bundle, /serviceWorker/, 'app should register the service worker');
  const example = await readFile(join(distDir, 'toc', 'example.md'), 'utf8');
  assert.match(example, /<!-- toc -->/);
  assert.equal(example, await readFile(join(repoRoot, 'test', 'resources', 'example.md'), 'utf8'));
});

test('toc page sets a same-origin content security policy', () => {
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
});

test('toc page title, description and keywords target markdown tables of contents', () => {
  assert.match(doc.title, /table of contents/i);
  assert.match(doc.title, /markdown/i);
  const desc = doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  assert.match(desc.toLowerCase(), /browser/);
  assert.match(desc.toLowerCase(), /readme/);
  const keywords = doc.querySelector('meta[name="keywords"]')?.getAttribute('content') ?? '';
  for (const phrase of ['markdown toc', 'table of contents generator', 'readme', 'github', '@0dep/toc']) {
    assert.ok(keywords.toLowerCase().includes(phrase), `keywords should include ${phrase}`);
  }
});

test('toc page has crawlable about content, FAQ JSON-LD and source link', () => {
  const about = doc.querySelector('section.run-about');
  assert.ok(about, 'about section not found');
  assert.match(about.textContent, /never leave/i);
  assert.match(about.textContent.toLowerCase(), /offline/);
  assert.ok(about.querySelector('a[href="https://github.com/zerodep/toc"]'), 'should link toc');
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

test('toc page works offline — own service worker with toc- cache prefix', async () => {
  const sw = await readFile(join(distDir, 'toc', 'sw.js'), 'utf8');
  assert.match(sw, /'toc-[0-9a-f]+'/);
  assert.ok(sw.includes(`key.startsWith('toc-')`));
  for (const asset of ['/toc/', '/toc/index.html', '/toc/app.js', '/toc/example.md', '/styles.css']) {
    assert.ok(sw.includes(`"${asset}"`), `should precache ${asset}`);
  }
});

test('toc page canonical link is /toc/', () => {
  assert.equal(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'), `https://${manifest.site.primaryDomain}/toc/`);
});

test('home nav, sitemap and llms.txt list /toc/', async () => {
  const homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  assert.ok(homeDoc.querySelector('nav a[href="/toc/"]'), 'toc link in nav not found');
  const sitemap = await readFile(join(distDir, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.split('<url>').some((u) => u.includes('/toc/</loc>')), 'sitemap should list /toc/');
  const llms = await readFile(join(distDir, 'llms.txt'), 'utf8');
  assert.match(llms, /\/toc\/\)/);
});

test('home toc card links to the toc page', async () => {
  const homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  const card = homeDoc.querySelector('article.project#toc');
  assert.ok(card, 'toc card not found');
  assert.ok(card.querySelector('.links a[href="/toc/"]'), 'toc card should link to /toc/');
});

test('toc page links to the other tool pages', () => {
  assert.ok(doc.querySelector('a[href="/tools/"]'));
  assert.ok(doc.querySelector('a[href="/run/"]'));
});
