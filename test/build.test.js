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

let homeDoc;
let aboutDoc;
let homeHtmlRaw;
let manifest;
let profile;

before(async () => {
  await rm(distDir, { recursive: true, force: true });
  const { build } = await import('../src/build.js');
  await build();

  homeHtmlRaw = await readFile(join(distDir, 'index.html'), 'utf8');
  homeDoc = parseHtml(homeHtmlRaw);
  const aboutHtmlRaw = await readFile(join(distDir, 'about', 'index.html'), 'utf8');
  aboutDoc = parseHtml(aboutHtmlRaw);

  manifest = JSON.parse(await readFile(join(repoRoot, 'data', 'projects.json'), 'utf8'));
  profile = JSON.parse(await readFile(join(repoRoot, 'data', 'profile.json'), 'utf8'));
});

// ---------- file artefacts ----------

test('writes index.html', async () => {
  assert.ok((await stat(join(distDir, 'index.html'))).isFile());
});

test('writes styles.css', async () => {
  assert.ok((await stat(join(distDir, 'styles.css'))).isFile());
});

test('writes about/index.html', async () => {
  assert.ok((await stat(join(distDir, 'about', 'index.html'))).isFile());
});

test('writes 404.html with noindex and back-to-home link', async () => {
  const raw = await readFile(join(distDir, '404.html'), 'utf8');
  const doc = parseHtml(raw);
  assert.equal(
    doc.querySelector('meta[name="robots"]')?.getAttribute('content'),
    'noindex',
    '404 page should be noindex',
  );
  assert.ok(doc.querySelector('a[href="/"]'), 'should link back to home');
  assert.match(doc.querySelector('h1')?.textContent ?? '', /404/);
});

test('writes CNAME with primary domain', async () => {
  const cname = (await readFile(join(distDir, 'CNAME'), 'utf8')).trim();
  assert.equal(cname, manifest.site.primaryDomain);
});

test('copies brand assets to dist', async () => {
  const avatar = profile.avatar.replace(/^\//, '');
  for (const f of ['logo.png', 'favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png', avatar]) {
    assert.ok((await stat(join(distDir, f))).isFile(), `missing asset: ${f}`);
  }
});

// ---------- home page ----------

test('home: html starts with doctype', () => {
  assert.match(homeHtmlRaw.slice(0, 20).toLowerCase(), /^<!doctype html>/);
});

test('home: html element has lang', () => {
  assert.ok(homeDoc.documentElement.getAttribute('lang'));
});

test('home: charset and viewport meta', () => {
  assert.equal(homeDoc.querySelector('meta[charset]')?.getAttribute('charset'), 'utf-8');
  assert.ok(homeDoc.querySelector('meta[name="viewport"]'));
});

test('home: title contains site title and mentions bpmn', () => {
  assert.ok(homeDoc.title.includes(manifest.site.title));
  assert.match(homeDoc.title.toLowerCase(), /bpmn/);
});

test('home: meta description mentions bpmn', () => {
  const desc = homeDoc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  assert.match(desc.toLowerCase(), /bpmn/);
});

test('home: keywords meta includes bpmn, dmn, and zerodep', () => {
  const k = homeDoc.querySelector('meta[name="keywords"]')?.getAttribute('content') || '';
  assert.ok(k.toLowerCase().includes('bpmn'), 'keywords should include bpmn');
  assert.ok(k.toLowerCase().includes('dmn'), 'keywords should include dmn');
  assert.ok(k.toLowerCase().includes('decision table'), 'keywords should include decision table');
  assert.ok(k.toLowerCase().includes('zerodep'), 'keywords should include zerodep');
});

test('home: meta description mentions dmn decisions', () => {
  const desc = homeDoc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  assert.match(desc.toLowerCase(), /dmn/);
});

test('home: canonical link is the apex URL', () => {
  const href = homeDoc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  assert.equal(href, `https://${manifest.site.primaryDomain}/`);
});

test('home: open graph tags', () => {
  for (const prop of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type', 'og:site_name']) {
    const el = homeDoc.querySelector(`meta[property="${prop}"]`);
    assert.ok(el, `og tag missing: ${prop}`);
    assert.ok(el.getAttribute('content'), `og tag empty: ${prop}`);
  }
  assert.equal(
    homeDoc.querySelector('meta[property="og:type"]').getAttribute('content'),
    'website',
  );
});

test('home: twitter card uses summary_large_image', () => {
  assert.equal(
    homeDoc.querySelector('meta[name="twitter:card"]')?.getAttribute('content'),
    'summary_large_image',
  );
});

test('home: JSON-LD includes WebSite, Organization and ItemList', async () => {
  const scripts = [...homeDoc.querySelectorAll('script[type="application/ld+json"]')];
  assert.ok(scripts.length >= 1, 'no JSON-LD scripts');
  const types = new Set();
  for (const s of scripts) {
    const data = JSON.parse(s.textContent);
    const arr = Array.isArray(data) ? data : [data];
    for (const item of arr) {
      assert.equal(item['@context'], 'https://schema.org');
      types.add(item['@type']);
    }
  }
  for (const want of ['WebSite', 'Organization', 'ItemList']) {
    assert.ok(types.has(want), `JSON-LD missing @type: ${want}`);
  }
});

test('home: header tagline and intro', () => {
  assert.equal(
    homeDoc.querySelector('.site-header .tagline').textContent,
    manifest.site.tagline,
  );
  assert.equal(
    homeDoc.querySelector('.site-header .intro').textContent,
    manifest.site.intro,
  );
});

test('home: logo image in header', () => {
  const img = homeDoc.querySelector('.site-header h1 img');
  assert.ok(img, 'logo <img> not found');
  assert.equal(img.getAttribute('src'), '/logo.png');
  assert.equal(img.getAttribute('alt'), manifest.site.title);
});

test('home: favicon and apple-touch-icon links', () => {
  const f32 = homeDoc.querySelector('link[rel="icon"][sizes="32x32"]');
  const f192 = homeDoc.querySelector('link[rel="icon"][sizes="192x192"]');
  const apple = homeDoc.querySelector('link[rel="apple-touch-icon"]');
  assert.equal(f32?.getAttribute('href'), '/favicon-32.png');
  assert.equal(f192?.getAttribute('href'), '/favicon-192.png');
  assert.equal(apple?.getAttribute('href'), '/apple-touch-icon.png');
});

test('home: every group renders with title, description, and projects', () => {
  for (const group of manifest.groups) {
    const section = homeDoc.querySelector(`section#${group.id}`);
    assert.ok(section, `group section missing: ${group.id}`);
    assert.equal(section.querySelector('.group-header h2').textContent, group.title);
    assert.equal(section.querySelector('.group-header p').textContent, group.description);

    for (const p of group.projects) {
      const article = section.querySelector(`article#${p.slug}`);
      assert.ok(article, `project article missing: ${p.slug}`);

      const titleLink = article.querySelector('h3 a');
      assert.equal(titleLink.textContent, p.name);
      assert.equal(titleLink.getAttribute('href'), p.repo);

      assert.equal(article.querySelector('p').textContent, p.description);

      const tags = [...article.querySelectorAll('.tags li')].map((li) => li.textContent);
      assert.deepEqual(tags, p.tags);

      const linkHrefs = [...article.querySelectorAll('p.links a')].map((a) =>
        a.getAttribute('href'),
      );
      assert.ok(linkHrefs.includes(p.repo), `${p.slug}: repo link missing in links row`);
      if (p.npm) {
        assert.ok(
          linkHrefs.includes(`https://www.npmjs.com/package/${p.npm}`),
          `${p.slug}: npm link missing`,
        );
      }
    }
  }
});

test('home: nav links to /about/', () => {
  assert.ok(homeDoc.querySelector('nav a[href="/about/"]'), 'about link in nav not found');
});

test('home: footer links to LinkedIn, GitHub org, npm scope', () => {
  assert.ok(homeDoc.querySelector(`a[href="${manifest.site.linkedin}"]`));
  assert.ok(homeDoc.querySelector(`a[href="${manifest.site.githubOrg}"]`));
  assert.ok(homeDoc.querySelector(`a[href="${manifest.site.npmScope}"]`));
});

test('home: only JSON-LD script tags (no executable JS)', () => {
  const nonLd = [...homeDoc.querySelectorAll('script')].filter(
    (s) => s.getAttribute('type') !== 'application/ld+json',
  );
  assert.equal(nonLd.length, 0, 'unexpected executable <script> tag');
});

test('home: no unrendered template placeholders', () => {
  assert.doesNotMatch(homeHtmlRaw, /\{\{[^}]+\}\}/);
});

// ---------- about page ----------

test('about: title contains the name', () => {
  assert.ok(aboutDoc.title.includes(profile.name));
});

test('about: h1 is the name, tagline is the headline', () => {
  assert.equal(aboutDoc.querySelector('h1').textContent, profile.name);
  assert.equal(aboutDoc.querySelector('.tagline').textContent, profile.headline);
});

test('about: avatar image references profile.avatar with alt=name', () => {
  const img = aboutDoc.querySelector('img.avatar');
  assert.ok(img, 'avatar <img> not found');
  assert.equal(img.getAttribute('src'), profile.avatar);
  assert.equal(img.getAttribute('alt'), profile.name);
});

test('about: bio paragraphs match manifest order and content', () => {
  const paragraphs = [...aboutDoc.querySelectorAll('main.profile .bio p')].map(
    (p) => p.textContent,
  );
  assert.deepEqual(paragraphs, profile.bio);
});

test('about: highlights render as dt/dd pairs', () => {
  const dts = [...aboutDoc.querySelectorAll('.highlights dt')].map((n) => n.textContent);
  const dds = [...aboutDoc.querySelectorAll('.highlights dd')].map((n) => n.textContent);
  assert.deepEqual(
    dts,
    profile.highlights.map((h) => h.label),
  );
  assert.deepEqual(
    dds,
    profile.highlights.map((h) => h.value),
  );
});

test('about: profile links render with correct href and label', () => {
  const links = [...aboutDoc.querySelectorAll('.profile-links a')];
  for (const want of profile.links) {
    const found = links.find((a) => a.getAttribute('href') === want.url);
    assert.ok(found, `link missing: ${want.label}`);
    assert.equal(found.textContent, want.label);
  }
});

test('about: back link points to /', () => {
  assert.equal(aboutDoc.querySelector('.back a')?.getAttribute('href'), '/');
});

test('about: shared assets use absolute paths', () => {
  assert.equal(
    aboutDoc.querySelector('link[rel="stylesheet"]')?.getAttribute('href'),
    '/styles.css',
  );
  assert.equal(
    aboutDoc.querySelector('link[rel="icon"][sizes="32x32"]')?.getAttribute('href'),
    '/favicon-32.png',
  );
});

test('about: canonical link is /about/', () => {
  const href = aboutDoc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  assert.equal(href, `https://${manifest.site.primaryDomain}/about/`);
});

test('about: og:type is profile', () => {
  assert.equal(
    aboutDoc.querySelector('meta[property="og:type"]')?.getAttribute('content'),
    'profile',
  );
});

test('about: JSON-LD has Person with image', () => {
  const scripts = [...aboutDoc.querySelectorAll('script[type="application/ld+json"]')];
  let person;
  for (const s of scripts) {
    const data = JSON.parse(s.textContent);
    const arr = Array.isArray(data) ? data : [data];
    for (const item of arr) if (item['@type'] === 'Person') person = item;
  }
  assert.ok(person, 'about page JSON-LD should include Person');
  assert.equal(person.image, `https://${manifest.site.primaryDomain}${profile.avatar}`);
});

// ---------- crawl files ----------

test('writes robots.txt that allows all and points to sitemap', async () => {
  const robots = await readFile(join(distDir, 'robots.txt'), 'utf8');
  assert.match(robots, /User-agent:\s*\*/i);
  assert.match(robots, /Allow:\s*\//);
  assert.match(robots, new RegExp(`Sitemap:\\s*https://${manifest.site.primaryDomain}/sitemap\\.xml`));
});

test('writes sitemap.xml listing home and about', async () => {
  const sitemap = await readFile(join(distDir, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes(`<loc>https://${manifest.site.primaryDomain}/</loc>`));
  assert.ok(sitemap.includes(`<loc>https://${manifest.site.primaryDomain}/about/</loc>`));
});

test('static/ files are copied verbatim to dist', async () => {
  const staticDir = join(repoRoot, 'static');
  let files;
  try {
    files = await readdir(staticDir);
  } catch {
    return; // static/ optional — only run when it exists
  }
  for (const f of files) {
    if (f === '.DS_Store') continue;
    const dst = await readFile(join(distDir, f));
    const src = await readFile(join(staticDir, f));
    assert.ok(dst.equals(src), `static/${f} not copied to dist verbatim`);
  }
});

// ---------- favicon byte-level checks ----------

test('browser favicons have tRNS chunk (white keyed transparent)', async () => {
  for (const f of ['favicon-32.png', 'favicon-192.png']) {
    const buf = await readFile(join(distDir, f));
    assert.ok(
      buf.includes(Buffer.from('tRNS', 'ascii')),
      `${f} should contain a tRNS chunk to make white transparent`,
    );
  }
});

test('apple-touch-icon keeps white background (no tRNS)', async () => {
  const buf = await readFile(join(distDir, 'apple-touch-icon.png'));
  assert.ok(
    !buf.includes(Buffer.from('tRNS', 'ascii')),
    'apple-touch-icon should not have tRNS — white bg is conventional on iOS',
  );
});
