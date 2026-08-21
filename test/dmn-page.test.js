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

let dmnDoc;
let manifest;

before(async () => {
  await rm(distDir, { recursive: true, force: true });
  const { build } = await import('../src/build.js');
  await build();

  dmnDoc = parseHtml(await readFile(join(distDir, 'dmn', 'index.html'), 'utf8'));
  manifest = JSON.parse(await readFile(join(repoRoot, 'data', 'projects.json'), 'utf8'));
});

test('writes dmn/index.html', async () => {
  assert.ok((await stat(join(distDir, 'dmn', 'index.html'))).isFile());
});

test('dmn page has a source textarea inside a drop zone', () => {
  const zone = dmnDoc.querySelector('[data-dropzone]');
  assert.ok(zone, 'drop zone element not found');
  assert.ok(zone.querySelector('textarea#source'), 'textarea#source not found in the drop zone');
});

test('dmn page has an evaluate button and a decision picker', () => {
  assert.ok(dmnDoc.querySelector('button#evaluate'), 'evaluate button not found');
  assert.ok(dmnDoc.querySelector('select#decision'), 'decision select not found');
});

test('dmn page has a JSON input-data textarea', () => {
  assert.ok(dmnDoc.querySelector('textarea#input-data'), 'input-data textarea not found');
  const label = dmnDoc.querySelector('label[for="input-data"]');
  assert.match(label?.textContent ?? '', /JSON/i, 'label should mention JSON');
});

test('dmn page has a decision table container above the result', () => {
  const tables = dmnDoc.querySelector('#tables');
  assert.ok(tables, 'decision tables container not found');
  const result = dmnDoc.querySelector('#result');
  assert.ok(result, 'result element not found');
  assert.ok(
    tables.compareDocumentPosition(result) & 4, // DOCUMENT_POSITION_FOLLOWING
    'result should come after the rendered tables',
  );
  const resultBlock = dmnDoc.querySelector('#result-block');
  assert.ok(resultBlock?.hasAttribute('hidden'), 'result block should start hidden');
});

test('dmn page has a trace table in its own hidden collapsible', () => {
  const details = dmnDoc.querySelector('details#trace-details');
  assert.ok(details, 'trace details not found');
  assert.ok(details.hasAttribute('hidden'), 'trace should start hidden until an evaluation completes');
  assert.match(details.querySelector('summary')?.textContent ?? '', /trace/i);
  const table = details.querySelector('table#trace');
  assert.ok(table, 'trace table not found');
  assert.ok(table.querySelector('tbody#trace-body'), 'trace tbody missing');
  const headers = [...table.querySelectorAll('th')].map((th) => th.textContent.toLowerCase());
  assert.ok(headers.some((h) => h.includes('rules')), 'trace should have a matched-rules column');
  assert.ok(headers.some((h) => h.includes('result')), 'trace should have a result column');
});

test('dmn page has a collapsed evaluation log', () => {
  const details = dmnDoc.querySelector('details#log-details');
  assert.ok(details, 'details#log-details not found');
  assert.ok(!details.hasAttribute('open'), 'log should be collapsed by default');
  assert.match(details.querySelector('summary')?.textContent ?? '', /log/i);
  assert.ok(details.querySelector('#log'), 'log should be inside the collapsible');
});

test('example resource is copied verbatim to dist/dmn', async () => {
  const dst = await readFile(join(distDir, 'dmn', 'discount.dmn'), 'utf8');
  const src = await readFile(join(repoRoot, 'test', 'resources', 'discount.dmn'), 'utf8');
  assert.equal(dst, src, 'discount.dmn should be copied from test/resources');
  assert.ok(dmnDoc.querySelector('button#example'), 'example button not found');
});

test('dmn page loads the bundled app as a module', () => {
  const script = dmnDoc.querySelector('script[type="module"]');
  assert.ok(script, 'module script tag not found');
  assert.equal(script.getAttribute('src'), '/dmn/app.js');
});

test('bundles dmn/app.js for the browser (no node built-ins, includes engine)', async () => {
  const bundle = await readFile(join(distDir, 'dmn', 'app.js'), 'utf8');
  assert.ok(bundle.length > 50_000, 'bundle suspiciously small — engine not included?');
  assert.ok(!/["']node:[a-z/]+["']/.test(bundle), 'bundle references node built-ins');
});

test('dmn page sets a same-origin content security policy', () => {
  const csp = dmnDoc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.ok(csp, 'CSP meta not found');
  const content = csp.getAttribute('content');
  assert.match(content, /default-src 'self'/);
  assert.match(content, /object-src 'none'/);
});

test('dmn page title and description target online-evaluator searches', () => {
  assert.match(dmnDoc.title.toLowerCase(), /dmn/);
  assert.match(dmnDoc.title.toLowerCase(), /online/);
  const desc = dmnDoc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  assert.match(desc.toLowerCase(), /browser/);
  assert.match(desc.toLowerCase(), /decision/);
  const keywords = dmnDoc.querySelector('meta[name="keywords"]')?.getAttribute('content') ?? '';
  for (const phrase of ['dmn decision table online', 'evaluate dmn online', 'online dmn runner', 'dmn evaluator', 'camunda dmn', 'decision requirements graph', 'feel expression']) {
    assert.ok(keywords.toLowerCase().includes(phrase), `keywords should include ${phrase}`);
  }
});

test('dmn page about content covers chained decisions and modeler exports', () => {
  const about = dmnDoc.querySelector('section.run-about');
  assert.match(about.textContent.toLowerCase(), /chained|requirement graph/, 'should mention chained decisions / the DRG');
  assert.match(about.textContent, /Camunda Modeler/, 'should mention Camunda Modeler exports');
});

test('dmn page has WebApplication and FAQPage JSON-LD', () => {
  const types = new Set();
  const faqs = [];
  for (const s of dmnDoc.querySelectorAll('script[type="application/ld+json"]')) {
    const data = JSON.parse(s.textContent);
    for (const item of Array.isArray(data) ? data : [data]) {
      assert.equal(item['@context'], 'https://schema.org');
      types.add(item['@type']);
      if (item['@type'] === 'FAQPage') faqs.push(...item.mainEntity);
    }
  }
  assert.ok(types.has('WebApplication'), 'JSON-LD missing WebApplication');
  assert.ok(types.has('FAQPage'), 'JSON-LD missing FAQPage');
  assert.ok(faqs.length >= 3, 'FAQPage should have at least three questions');
});

test('dmn page has crawlable about content matching the FAQ', () => {
  const about = dmnDoc.querySelector('section.run-about');
  assert.ok(about, 'about section not found');
  assert.match(about.textContent.toLowerCase(), /browser/);
  assert.match(about.textContent.toLowerCase(), /never leave/i, 'should state decisions are not uploaded');
  assert.match(about.textContent.toLowerCase(), /no data is transmitted/i, 'should state no data is transmitted');
  assert.match(about.textContent.toLowerCase(), /offline/, 'about should mention offline support');

  const sourceLink = about.querySelector('a[href="https://github.com/zerodep/0dep.se"]');
  assert.ok(sourceLink, 'about section should link to the site source');

  const faqLd = [...dmnDoc.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => JSON.parse(s.textContent))
    .flatMap((d) => (Array.isArray(d) ? d : [d]))
    .find((d) => d['@type'] === 'FAQPage');
  for (const q of faqLd.mainEntity) {
    assert.ok(
      about.textContent.includes(q.name),
      `FAQ question should be visible on the page: ${q.name}`,
    );
  }
});

test('dmn page works offline — service worker precaches the runner', async () => {
  const sw = await readFile(join(distDir, 'dmn', 'sw.js'), 'utf8');
  assert.match(sw, /dmn-[0-9a-f]+/, 'cache name should carry a build version');
  for (const asset of [
    '/dmn/',
    '/dmn/index.html',
    '/dmn/app.js',
    '/dmn/discount.dmn',
    '/styles.css',
  ]) {
    assert.ok(sw.includes(`"${asset}"`), `service worker should precache ${asset}`);
  }

  const app = await readFile(join(distDir, 'dmn', 'app.js'), 'utf8');
  assert.match(app, /serviceWorker/, 'app should register the service worker');
});

test('dmn service worker does not clobber the run cache and vice versa', async () => {
  const dmnSw = await readFile(join(distDir, 'dmn', 'sw.js'), 'utf8');
  assert.ok(dmnSw.includes(`key.startsWith('dmn-')`), 'dmn sw should only drop dmn- caches');
  const runSw = await readFile(join(distDir, 'run', 'sw.js'), 'utf8');
  assert.ok(runSw.includes(`key.startsWith('run-')`), 'run sw should only drop run- caches');
});

test('dmn page canonical link is /dmn/', () => {
  const href = dmnDoc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  assert.equal(href, `https://${manifest.site.primaryDomain}/dmn/`);
});

test('home nav links to /dmn/', async () => {
  const homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  assert.ok(homeDoc.querySelector('nav a[href="/dmn/"]'), 'dmn link in nav not found');
});

test('dmn page input form wraps the toolbar above the tables, evaluate submits it', () => {
  const form = dmnDoc.querySelector('.dmn-view form#input-form');
  assert.ok(form, 'input form not found in the decisions section');
  const evaluate = form.querySelector('button#evaluate');
  assert.ok(evaluate, 'evaluate button should live inside the form');
  assert.equal(evaluate.getAttribute('type'), 'submit', 'evaluate should submit the form');
  assert.ok(form.querySelector('select#decision'), 'decision picker should live inside the form');

  const declared = form.querySelector('fieldset#declared-inputs');
  assert.ok(declared, 'declared inputs should be a framed fieldset');
  assert.ok(declared.hasAttribute('hidden'), 'declared inputs should start hidden');
  assert.ok(declared.querySelector('legend#declared-inputs-legend'), 'fieldset should carry a naming legend');
  assert.ok(declared.querySelector('#input-fields'), 'input fields container missing');
  assert.match(declared.textContent.toLowerCase(), /json/, 'form should explain precedence over the JSON');

  const tables = dmnDoc.querySelector('#tables');
  assert.ok(
    form.compareDocumentPosition(tables) & 4, // DOCUMENT_POSITION_FOLLOWING
    'form should sit above the rendered tables',
  );
});

test('dmn page documents the registered demo services', () => {
  const hint = [...dmnDoc.querySelectorAll('section.run-input .hint')].map((el) => el.textContent).join(' ');
  assert.match(hint, /services\.takeOnce/, 'hint should document takeOnce');
  assert.match(hint, /services\.exchangeRate/, 'hint should document exchangeRate');
  assert.match(hint.toLowerCase(), /synchronous/, 'hint should state services must be synchronous');
});

test('home page dmn-elements card links to the dmn runner', async () => {
  const homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  const card = homeDoc.querySelector('article.project#dmn-elements');
  assert.ok(card, 'dmn-elements card not found');
  const link = card.querySelector('.links a[href="/dmn/"]');
  assert.ok(link, 'dmn-elements card should link to /dmn/ among its links');
  assert.ok(link.textContent.trim(), 'runner link should carry a label');
});

test('run and dmn pages cross-link', async () => {
  const runDoc = parseHtml(await readFile(join(distDir, 'run', 'index.html'), 'utf8'));
  assert.ok(runDoc.querySelector('a[href="/dmn/"]'), 'run page should link to /dmn/');
  assert.ok(dmnDoc.querySelector('a[href="/run/"]'), 'dmn page should link to /run/');
});

test('sitemap lists /dmn/ high and weekly', async () => {
  const sitemap = await readFile(join(distDir, 'sitemap.xml'), 'utf8');
  const entry = sitemap.split('<url>').find((u) => u.includes('/dmn/</loc>'));
  assert.ok(entry, 'sitemap should list /dmn/');
  assert.match(entry, /<priority>0.8<\/priority>/);
  assert.match(entry, /<changefreq>weekly<\/changefreq>/);
});
