import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Insert a tRNS chunk before the first IDAT marking pure-white pixels as transparent.
// Only valid for 8-bit RGB PNGs (color type 2). For colour type 2 + bit depth 8 the
// tRNS payload is six bytes — three 16-bit BE values where only the low byte is read.
function pngKeyWhiteTransparent(pngBuf) {
  if (pngBuf[25] !== 2 || pngBuf[24] !== 8) {
    throw new Error('expected 8-bit RGB PNG (color type 2, bit depth 8)');
  }
  const data = Buffer.from([0, 255, 0, 255, 0, 255]);
  const type = Buffer.from('tRNS', 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const trns = Buffer.concat([len, type, data, crc]);

  let p = 8;
  while (p < pngBuf.length) {
    const chunkLen = pngBuf.readUInt32BE(p);
    const chunkType = pngBuf.slice(p + 4, p + 8).toString('ascii');
    if (chunkType === 'IDAT') break;
    p += 12 + chunkLen;
  }
  return Buffer.concat([pngBuf.slice(0, p), trns, pngBuf.slice(p)]);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const projectsPath = join(root, 'data', 'projects.json');
const profilePath = join(root, 'data', 'profile.json');
const stylesSrc = join(root, 'src', 'styles.css');
const assetsDir = join(root, 'src', 'assets');
const distDir = join(root, 'dist');

const copyAssets = ['logo.png', 'apple-touch-icon.png'];
const transparentAssets = ['favicon-32.png', 'favicon-192.png'];

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => escapeMap[c]);

function head(title, description) {
  return `  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escape(description)}">
  <meta name="color-scheme" content="light dark">
  <title>${escape(title)}</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/styles.css">`;
}

function footer(site) {
  return `  <footer>
    <p>
      <a href="${escape(site.githubOrg)}" rel="noopener">github.com/zerodep</a>
      &middot;
      <a href="${escape(site.npmScope)}" rel="noopener">npm/~0dep</a>
      &middot;
      <a href="${escape(site.linkedin)}" rel="noopener">linkedin.com/in/pal-edman</a>
    </p>
    <p class="copy">&copy; Pål Edman &middot; MIT licensed</p>
  </footer>`;
}

function renderProject(p) {
  const links = [`<a href="${escape(p.repo)}" rel="noopener">GitHub</a>`];
  if (p.npm) {
    const npmUrl = `https://www.npmjs.com/package/${p.npm}`;
    links.push(`<a href="${escape(npmUrl)}" rel="noopener">npm</a>`);
  }
  const tags = p.tags.map((t) => `<li>${escape(t)}</li>`).join('');
  return `      <article class="project" id="${escape(p.slug)}">
        <header>
          <h3><a href="${escape(p.repo)}" rel="noopener">${escape(p.name)}</a></h3>
        </header>
        <p>${escape(p.description)}</p>
        <ul class="tags">${tags}</ul>
        <p class="links">${links.join(' &middot; ')}</p>
      </article>`;
}

function renderGroup(g) {
  return `    <section class="group" id="${escape(g.id)}">
      <header class="group-header">
        <h2>${escape(g.title)}</h2>
        <p>${escape(g.description)}</p>
      </header>
      <div class="projects">
${g.projects.map(renderProject).join('\n')}
      </div>
    </section>`;
}

function renderHome(manifest) {
  const { site, groups } = manifest;
  const groupNav = groups
    .map((g) => `<a href="#${escape(g.id)}">${escape(g.title)}</a>`)
    .join(' &middot; ');
  const navLinks = `${groupNav} &middot; <a href="/about/">About</a>`;

  return `<!doctype html>
<html lang="en">
<head>
${head(`${site.title} — ${site.tagline}`, site.tagline)}
</head>
<body>
  <header class="site-header">
    <h1><img src="/logo.png" alt="${escape(site.title)}" width="320" height="320"></h1>
    <p class="tagline">${escape(site.tagline)}</p>
    <p class="intro">${escape(site.intro)}</p>
    <nav>${navLinks}</nav>
  </header>
  <main>
${groups.map(renderGroup).join('\n')}
  </main>
${footer(site)}
</body>
</html>
`;
}

function renderAbout(profile, site) {
  const bio = profile.bio.map((p) => `    <p>${escape(p)}</p>`).join('\n');
  const highlights = profile.highlights
    .map(
      (h) => `      <div><dt>${escape(h.label)}</dt><dd>${escape(h.value)}</dd></div>`,
    )
    .join('\n');
  const links = profile.links
    .map((l) => `      <li><a href="${escape(l.url)}" rel="noopener">${escape(l.label)}</a></li>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
${head(`${profile.name} — ${site.title}`, `${profile.name} — ${profile.headline}`)}
</head>
<body>
  <header class="site-header profile-header">
    <p class="back"><a href="/">&larr; back to ${escape(site.title)}</a></p>
    <h1>${escape(profile.name)}</h1>
    <p class="tagline">${escape(profile.headline)}</p>
  </header>
  <main class="profile">
    <section class="bio">
${bio}
    </section>
    <dl class="highlights">
${highlights}
    </dl>
    <ul class="profile-links">
${links}
    </ul>
  </main>
${footer(site)}
</body>
</html>
`;
}

export async function build() {
  const manifest = JSON.parse(await readFile(projectsPath, 'utf8'));
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));

  await mkdir(distDir, { recursive: true });
  await mkdir(join(distDir, 'about'), { recursive: true });

  await writeFile(join(distDir, 'index.html'), renderHome(manifest));
  await writeFile(join(distDir, 'about', 'index.html'), renderAbout(profile, manifest.site));
  await copyFile(stylesSrc, join(distDir, 'styles.css'));
  for (const f of copyAssets) {
    await copyFile(join(assetsDir, f), join(distDir, f));
  }
  for (const f of transparentAssets) {
    const src = await readFile(join(assetsDir, f));
    await writeFile(join(distDir, f), pngKeyWhiteTransparent(src));
  }
  await writeFile(join(distDir, 'CNAME'), manifest.site.primaryDomain + '\n');
  return { distDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build().then(({ distDir }) => console.log(`built ${distDir}`));
}
