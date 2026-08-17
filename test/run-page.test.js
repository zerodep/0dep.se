import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
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

let runDoc;
let manifest;

before(async () => {
  await rm(distDir, { recursive: true, force: true });
  const { build } = await import('../src/build.js');
  await build();

  runDoc = parseHtml(await readFile(join(distDir, 'run', 'index.html'), 'utf8'));
  manifest = JSON.parse(await readFile(join(repoRoot, 'data', 'projects.json'), 'utf8'));
});

test('writes run/index.html', async () => {
  assert.ok((await stat(join(distDir, 'run', 'index.html'))).isFile());
});

test('run page has a source textarea for pasting a diagram', () => {
  assert.ok(runDoc.querySelector('textarea#source'), 'textarea#source not found');
});

test('run page has a drop zone', () => {
  assert.ok(runDoc.querySelector('[data-dropzone]'), 'drop zone element not found');
});

test('run page has a run button and an output log', () => {
  assert.ok(runDoc.querySelector('button#run'), 'run button not found');
  assert.ok(runDoc.querySelector('#log'), 'event log element not found');
});

test('log and output live in a collapsible section below the diagram', () => {
  const details = runDoc.querySelector('.run-canvas details#log-details');
  assert.ok(details, 'details#log-details not found in the diagram section');
  assert.ok(!details.hasAttribute('open'), 'log should be collapsed by default');
  assert.match(details.querySelector('summary')?.textContent ?? '', /log/i);
  assert.ok(details.querySelector('#log'), 'log should be inside the collapsible');
  assert.ok(details.querySelector('#output'), 'output should be inside the collapsible');

  const canvas = runDoc.querySelector('.run-canvas #canvas');
  assert.ok(
    canvas.compareDocumentPosition(details) & 4, // DOCUMENT_POSITION_FOLLOWING
    'collapsible log should come after the canvas',
  );
});

test('run page has a step button, disabled until a stepped run starts', () => {
  const step = runDoc.querySelector('button#step');
  assert.ok(step, 'step button not found');
  assert.ok(step.hasAttribute('disabled'), 'step button should start disabled');
});

test('action buttons sit above the displayed diagram', () => {
  const runBtn = runDoc.querySelector('.run-canvas button#run');
  assert.ok(runBtn, 'run button should live in the diagram section');
  assert.ok(runDoc.querySelector('.run-canvas button#step'), 'step button should live in the diagram section');
  const canvas = runDoc.querySelector('#canvas');
  assert.ok(
    runBtn.compareDocumentPosition(canvas) & 4, // DOCUMENT_POSITION_FOLLOWING
    'canvas should come after the action buttons',
  );
});

test('run page has a hidden stats table inside the execution log', () => {
  const details = runDoc.querySelector('#log-details');
  const table = details.querySelector('table#stats');
  assert.ok(table, 'stats table not found in log details');
  assert.ok(table.hasAttribute('hidden'), 'stats table should start hidden');
  assert.ok(table.querySelector('tbody#stats-body'), 'stats tbody missing');
  const headers = [...table.querySelectorAll('th')].map((th) => th.textContent.toLowerCase());
  assert.ok(headers.some((h) => h.includes('runs')), 'stats should have a runs column');
  assert.ok(headers.some((h) => h.includes('ms')), 'stats should have a time column');
  assert.ok(details.querySelector('#stats-total'), 'stats total line missing');
});

test('run page has a hidden properties panel for clicked diagram elements', () => {
  const props = runDoc.querySelector('.run-canvas #properties');
  assert.ok(props, 'properties panel not found in the diagram section');
  assert.ok(props.hasAttribute('hidden'), 'properties panel should start hidden');
  assert.ok(props.querySelector('#properties-title'), 'properties title missing');
  assert.ok(props.querySelector('#properties-taken'), 'properties taken-count line missing');
  assert.ok(props.querySelector('#properties-body'), 'properties body missing');
});

test('run page has a DMN drop list below the diagram', () => {
  const dmnSection = runDoc.querySelector('section.run-dmn[data-dmn-dropzone]');
  assert.ok(dmnSection, 'DMN dropzone section not found');
  assert.ok(dmnSection.querySelector('#dmn-list'), 'DMN list not found');
  assert.match(dmnSection.textContent, /\.dmn/i, 'section should mention .dmn files');

  const canvas = runDoc.querySelector('.run-canvas #canvas');
  assert.ok(
    canvas.compareDocumentPosition(dmnSection) & 4, // DOCUMENT_POSITION_FOLLOWING
    'DMN list should come below the diagram',
  );
});

test('run page has a JSON input for initial environment variables', () => {
  const varsEl = runDoc.querySelector('textarea#variables');
  assert.ok(varsEl, 'variables textarea not found');
  const label = runDoc.querySelector('label[for="variables"]');
  assert.match(label?.textContent ?? '', /JSON/i, 'label should mention JSON');
});

test('run page has step-mode and bypass checkboxes', () => {
  assert.ok(runDoc.querySelector('input[type="checkbox"]#step-mode'), 'step-mode checkbox not found');
  assert.ok(runDoc.querySelector('input[type="checkbox"]#bypass'), 'bypass checkbox not found');
});

test('run page has a loop-guard dropdown defaulting to 10 with 20 and 50', () => {
  const select = runDoc.querySelector('select#max-touches');
  assert.ok(select, 'loop-guard select not found');
  const options = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
  assert.deepEqual(options, ['10', '20', '50']);
  const selected = select.querySelector('option[selected]');
  assert.equal(selected?.getAttribute('value'), '10', 'default should be 10');
});

test('run page has a diagram canvas and links the bpmn-js viewer styles', async () => {
  assert.ok(runDoc.querySelector('#canvas'), 'diagram canvas not found');
  const hrefs = [...runDoc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
  assert.ok(hrefs.includes('/run/diagram-js.css'), 'diagram-js.css link missing');
  assert.ok(hrefs.includes('/run/bpmn-js.css'), 'bpmn-js.css link missing');
  for (const f of ['diagram-js.css', 'bpmn-js.css']) {
    assert.ok((await stat(join(distDir, 'run', f))).isFile(), `missing asset: run/${f}`);
  }
});

test('example resources are copied verbatim to dist/run', async () => {
  for (const f of ['pricing.bpmn', 'discount.dmn']) {
    const dst = await readFile(join(distDir, 'run', f), 'utf8');
    const src = await readFile(join(repoRoot, 'test', 'resources', f), 'utf8');
    assert.equal(dst, src, `${f} should be copied from test/resources`);
  }
});

test('bpmn-js viewer is split into a lazily loaded module chunk', async () => {
  const chunks = await readdir(join(distDir, 'run', 'chunks'));
  assert.ok(chunks.some((f) => f.endsWith('.js')), 'no js chunk emitted');
  const app = await readFile(join(distDir, 'run', 'app.js'), 'utf8');
  assert.ok(app.includes('import('), 'app.js should dynamically import the viewer chunk');
});

test('run page loads the bundled app as a module', () => {
  const script = runDoc.querySelector('script[type="module"]');
  assert.ok(script, 'module script tag not found');
  assert.equal(script.getAttribute('src'), '/run/app.js');
});

test('run page sets a same-origin content security policy', () => {
  const csp = runDoc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.ok(csp, 'CSP meta not found');
  const content = csp.getAttribute('content');
  assert.match(content, /default-src 'self'/);
  assert.match(content, /object-src 'none'/);
});

test('home page has no CSP meta (no scripts to govern beyond JSON-LD)', async () => {
  const homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  assert.equal(homeDoc.querySelector('meta[http-equiv="Content-Security-Policy"]'), null);
});

test('run page canonical link is /run/', () => {
  const href = runDoc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  assert.equal(href, `https://${manifest.site.primaryDomain}/run/`);
});

test('bundles run/app.js for the browser (no node built-ins, includes engine)', async () => {
  const bundle = await readFile(join(distDir, 'run', 'app.js'), 'utf8');
  assert.ok(bundle.length > 50_000, 'bundle suspiciously small — engine not included?');

  const jsFiles = [join(distDir, 'run', 'app.js')];
  for (const f of await readdir(join(distDir, 'run', 'chunks'))) {
    if (f.endsWith('.js')) jsFiles.push(join(distDir, 'run', 'chunks', f));
  }
  for (const file of jsFiles) {
    const src = await readFile(file, 'utf8');
    assert.ok(!/["']node:[a-z/]+["']/.test(src), `${file} references node built-ins`);
  }
});

test('home nav links to /run/', async () => {
  const homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  assert.ok(homeDoc.querySelector('nav a[href="/run/"]'), 'run link in nav not found');
});

test('sitemap lists /run/', async () => {
  const sitemap = await readFile(join(distDir, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes(`<loc>https://${manifest.site.primaryDomain}/run/</loc>`));
});
