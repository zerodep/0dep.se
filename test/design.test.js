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

let manifest;
let homeDoc;
let styles;

before(async () => {
  await rm(distDir, { recursive: true, force: true });
  const { build } = await import('../src/build.js');
  await build();
  manifest = JSON.parse(await readFile(join(repoRoot, 'data', 'projects.json'), 'utf8'));
  homeDoc = parseHtml(await readFile(join(distDir, 'index.html'), 'utf8'));
  styles = await readFile(join(distDir, 'styles.css'), 'utf8');
});

const allProjects = () => manifest.groups.flatMap((g) => g.projects);

// --- manifest: honest dependency counts ---

test('every project declares its runtime dependencies as a list of package names', () => {
  for (const p of allProjects()) {
    assert.ok(Array.isArray(p.runtimeDeps), `runtimeDeps array required: ${p.slug}`);
    for (const dep of p.runtimeDeps) assert.match(dep, /^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/, `${p.slug}: odd dep name ${dep}`);
  }
});

test('runtimeDeps match the published dependencies of packages installed locally', async () => {
  let checked = 0;
  for (const p of allProjects()) {
    if (!p.npm) continue;
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(repoRoot, 'node_modules', p.npm, 'package.json'), 'utf8'));
    } catch {
      continue; // not installed here — nothing to cross-check
    }
    checked += 1;
    assert.deepEqual(
      [...p.runtimeDeps].sort(),
      Object.keys(pkg.dependencies ?? {}).sort(),
      `${p.slug}: runtimeDeps should mirror the installed package's dependencies`,
    );
  }
  assert.ok(checked >= 3, 'expected several listed packages to be installed for cross-checking');
});

test('the zerodep group is actually dependency-free', () => {
  const group = manifest.groups.find((g) => g.id === 'zerodep');
  for (const p of group.projects) assert.deepEqual(p.runtimeDeps, [], `${p.slug} should have zero runtime deps`);
});

// --- home: the page is drawn in the notation it executes ---

test('home groups are lanes inside a pool, cards are tasks', () => {
  assert.ok(homeDoc.querySelector('main.pool'), 'main should be the pool');
  for (const group of manifest.groups) {
    const section = homeDoc.querySelector(`section#${group.id}`);
    assert.ok(section.classList.contains('lane'), `${group.id} should be a lane`);
    assert.ok(section.querySelector('.group-header h2.lane-label'), `${group.id} should carry a lane label`);
  }
  assert.ok(homeDoc.querySelectorAll('article.project.task').length >= allProjects().length, 'cards should be task shapes');
});

test('every card opens with its honest dependency count', () => {
  for (const p of allProjects()) {
    const article = homeDoc.querySelector(`article#${p.slug}`);
    const deps = article.querySelector('header .deps');
    assert.ok(deps, `${p.slug}: deps eyebrow missing`);
    const title = article.querySelector('header h3');
    assert.ok(title.compareDocumentPosition(deps) & 4, `${p.slug}: deps should sit below the package title`); // DOCUMENT_POSITION_FOLLOWING
    const n = p.runtimeDeps.length;
    if (n === 0) {
      assert.ok(deps.classList.contains('zero'), `${p.slug}: zero deps should be marked`);
      assert.ok(deps.querySelector('svg.ring'), `${p.slug}: zero deps should carry the ring mark`);
      assert.match(deps.textContent, /0 deps/);
    } else {
      assert.match(deps.textContent, new RegExp(`${n} dep${n === 1 ? '' : 's'}`), `${p.slug}: should state ${n} deps`);
      assert.match(deps.textContent, /builds on/, `${p.slug}: should say what it builds on`);
      for (const dep of p.runtimeDeps) assert.ok(deps.textContent.includes(dep), `${p.slug}: should name ${dep}`);
    }
    // the description stays the card's first paragraph
    assert.equal(article.querySelector('p').textContent, p.description);
  }
});

test('builds-on names link to sibling cards when the dependency is listed on the page', () => {
  const engine = homeDoc.querySelector('article#bpmn-engine .deps');
  assert.equal(engine.querySelector('a[href="#bpmn-elements"]')?.textContent, 'bpmn-elements');
  assert.ok(engine.querySelector('a[href="#moddle-context-serializer"]'));
  assert.ok(!engine.querySelector('a[href="#debug"]'), 'unlisted deps are plain text');
  const elements = homeDoc.querySelector('article#bpmn-elements .deps');
  assert.equal(elements.querySelector('a[href="#piso"]')?.textContent, '@0dep/piso');
  assert.ok(elements.querySelector('a[href="#smqp"]'));
});

test('card and group links are verbs, not "try it" sentences', () => {
  for (const p of allProjects()) {
    if (!p.link) continue;
    assert.ok(!/^try it/i.test(p.link.label), `${p.slug}: link label should lead with what happens: ${p.link.label}`);
    assert.ok(p.link.label.length <= 32, `${p.slug}: link label should be short: ${p.link.label}`);
    const a = homeDoc.querySelector(`article#${p.slug} p.links a[href="${p.link.href}"]`);
    assert.ok(a, `${p.slug}: card link missing`);
  }
  for (const g of manifest.groups) {
    if (g.link) assert.ok(!/^try it/i.test(g.link.label), `${g.id}: group link label should lead with a verb`);
  }
});

test('the logo is trimmed to its wordmark and the header img declares its real size', async () => {
  const png = await readFile(join(distDir, 'logo.png'));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.ok(width / height > 2.5, `logo should be a wide wordmark, got ${width}x${height}`);
  const img = homeDoc.querySelector('.site-header h1 img');
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  assert.ok(Math.abs(w / h - width / height) < 0.02, `img width/height (${w}x${h}) should match the file's aspect ratio`);
});

test('social cards and JSON-LD use the square og-image, not the wordmark', async () => {
  const png = await readFile(join(distDir, 'og-image.png'));
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20), 'og-image should be square');
  const og = homeDoc.querySelector('meta[property="og:image"]')?.getAttribute('content');
  assert.equal(og, `https://${manifest.site.primaryDomain}/og-image.png`);
  assert.ok(!homeDoc.querySelector('footer .end-event'), 'the footer end event is gone');
});

test('the avatar ships as a small colour cut-out on the card ground', async () => {
  const png = await readFile(join(distDir, 'avatar.png'));
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20), 'avatar should be square');
  assert.ok(png.readUInt32BE(16) <= 512, 'avatar should be downscaled — it renders at 9rem');
  assert.equal(png[25], 6, 'avatar should keep colour with alpha (PNG color type 6)');
  assert.ok(png.length < 300_000, `avatar should be small, got ${png.length} bytes`);
  assert.match(styles, /\.profile-header \.avatar \{[^}]*var\(--card\)/, 'avatar sits on the card ground');
});

test('sub pages carry the ring mark linking home', async () => {
  const png = await readFile(join(distDir, 'logo-mark.png'));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  const ratio = png.readUInt32BE(16) / png.readUInt32BE(20);
  assert.ok(ratio > 0.8 && ratio < 1.6, `mark should be the ring alone, got ratio ${ratio}`);
  for (const page of ['run', 'dmn', 'tools', 'about']) {
    const doc = parseHtml(await readFile(join(distDir, page, 'index.html'), 'utf8'));
    const img = doc.querySelector('header .back a[href="/"] img.mark');
    assert.ok(img, `${page}: home link should carry the mark`);
    assert.equal(img.getAttribute('src'), '/logo-mark.png');
    assert.ok(img.getAttribute('width') && img.getAttribute('height'), `${page}: mark should declare its size`);
  }
});

// --- styles: type, tokens, motion ---

test('self-hosted display, body and mono faces are declared and shipped', async () => {
  for (const family of ['Jost', 'IBM Plex Sans', 'IBM Plex Mono']) {
    assert.ok(styles.includes(`font-family: '${family}'`) || styles.includes(`font-family: "${family}"`), `@font-face for ${family}`);
  }
  assert.match(styles, /font-display:\s*swap/);
  for (const f of ['jost-latin.woff2', 'ibm-plex-sans-latin.woff2', 'ibm-plex-mono-latin.woff2']) {
    assert.ok((await stat(join(distDir, 'fonts', f))).isFile(), `dist/fonts/${f} should be shipped`);
    assert.ok(styles.includes(`/fonts/${f}`), `styles should reference /fonts/${f}`);
  }
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(styles), 'no remote font hosts — CSP is same-origin');
  // OFL: the licence texts travel with the font files they cover
  for (const f of ['LICENSE-jost.txt', 'LICENSE-ibm-plex.txt']) {
    const shipped = await readFile(join(distDir, 'fonts', f), 'utf8');
    assert.match(shipped, /SIL OPEN FONT LICENSE/, `dist/fonts/${f} should be the OFL text`);
    assert.equal(shipped, await readFile(join(repoRoot, 'src', 'assets', 'fonts', f), 'utf8'), `${f} should be copied verbatim`);
  }
});

test('tokens: paper, ink, grid, slate and a single live color in both schemes', () => {
  for (const token of ['--paper', '--ink', '--grid', '--slate', '--token', '--token-fill']) {
    assert.ok(styles.includes(`${token}:`), `token ${token} should be defined`);
  }
  assert.match(styles, /@media \(prefers-color-scheme: dark\)/);
  assert.ok(!styles.includes('#fafaf7'), 'the warm cream ground is gone');
});

test('runner pages precache the fonts for offline use', async () => {
  for (const page of ['run', 'dmn', 'tools']) {
    const sw = await readFile(join(distDir, page, 'sw.js'), 'utf8');
    assert.ok(sw.includes('"/fonts/jost-latin.woff2"'), `${page} service worker should precache the display font`);
  }
});
