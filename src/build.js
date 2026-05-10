import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
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
const staticDir = join(root, 'static');
const distDir = join(root, 'dist');

const copyAssets = ['logo.png', 'apple-touch-icon.png'];
const transparentAssets = ['favicon-32.png', 'favicon-192.png'];

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => escapeMap[c]);

function head({
  site,
  title,
  description,
  path,
  keywords = '',
  ogType = 'website',
  ogImage = '/logo.png',
}) {
  const baseUrl = `https://${site.primaryDomain}`;
  const url = `${baseUrl}${path}`;
  const imageAbs = ogImage.startsWith('http') ? ogImage : `${baseUrl}${ogImage}`;
  const keywordsTag = keywords ? `\n  <meta name="keywords" content="${escape(keywords)}">` : '';
  return `  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escape(description)}">${keywordsTag}
  <meta name="color-scheme" content="light dark">
  <link rel="canonical" href="${escape(url)}">
  <title>${escape(title)}</title>
  <meta property="og:type" content="${escape(ogType)}">
  <meta property="og:title" content="${escape(title)}">
  <meta property="og:description" content="${escape(description)}">
  <meta property="og:url" content="${escape(url)}">
  <meta property="og:image" content="${escape(imageAbs)}">
  <meta property="og:site_name" content="${escape(site.title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escape(title)}">
  <meta name="twitter:description" content="${escape(description)}">
  <meta name="twitter:image" content="${escape(imageAbs)}">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/styles.css">`;
}

function jsonLd(data) {
  // Escape the closing-script sequence so it's safe inside <script>.
  const json = JSON.stringify(data, null, 2).replace(/<\/script/gi, '<\\/script');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

function ldHome(manifest) {
  const { site, groups } = manifest;
  const baseUrl = `https://${site.primaryDomain}`;
  const projects = groups.flatMap((g) => g.projects);
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: site.title,
      url: `${baseUrl}/`,
      description: site.seoDescription,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: site.title,
      url: `${baseUrl}/`,
      logo: `${baseUrl}/logo.png`,
      sameAs: [site.githubOrg, site.npmScope, site.linkedin].filter(Boolean),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'zerodep packages and BPMN engine ecosystem',
      itemListElement: projects.map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'SoftwareSourceCode',
          name: p.name,
          description: p.description,
          codeRepository: p.repo,
          programmingLanguage: 'JavaScript',
          ...(p.npm ? { url: `https://www.npmjs.com/package/${p.npm}` } : {}),
          keywords: p.tags.join(', '),
        },
      })),
    },
  ];
}

function ldAbout(profile, site) {
  const baseUrl = `https://${site.primaryDomain}`;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: profile.name,
      description: profile.headline,
      url: `${baseUrl}/about/`,
      ...(profile.avatar ? { image: `${baseUrl}${profile.avatar}` } : {}),
      sameAs: profile.links
        .filter((l) => !l.url.startsWith('mailto:'))
        .map((l) => l.url),
    },
  ];
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
  const ldBlocks = ldHome(manifest).map(jsonLd).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
${head({
    site,
    title: site.seoTitle || `${site.title} — ${site.tagline}`,
    description: site.seoDescription || site.tagline,
    path: '/',
    keywords: (site.keywords || []).join(', '),
    ogImage: site.ogImage,
  })}
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
${ldBlocks}
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
  const ldBlocks = ldAbout(profile, site).map(jsonLd).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
${head({
    site,
    title: profile.seoTitle || `${profile.name} — ${site.title}`,
    description: profile.seoDescription || `${profile.name} — ${profile.headline}`,
    path: '/about/',
    ogType: 'profile',
    ogImage: profile.ogImage || site.ogImage,
  })}
</head>
<body>
  <header class="site-header profile-header">
    <p class="back"><a href="/">&larr; back to ${escape(site.title)}</a></p>
    ${profile.avatar ? `<img class="avatar" src="${escape(profile.avatar)}" alt="${escape(profile.name)}" width="200" height="200">` : ''}
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
${ldBlocks}
</body>
</html>
`;
}

function robotsTxt(site) {
  return `User-agent: *
Allow: /

Sitemap: https://${site.primaryDomain}/sitemap.xml
`;
}

function sitemapXml(site) {
  const base = `https://${site.primaryDomain}`;
  const today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${base}/about/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>
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
  if (profile.avatar) {
    const file = profile.avatar.replace(/^\//, '');
    await copyFile(join(assetsDir, file), join(distDir, file));
  }
  for (const f of transparentAssets) {
    const src = await readFile(join(assetsDir, f));
    await writeFile(join(distDir, f), pngKeyWhiteTransparent(src));
  }
  await writeFile(join(distDir, 'CNAME'), manifest.site.primaryDomain + '\n');
  await writeFile(join(distDir, 'robots.txt'), robotsTxt(manifest.site));
  await writeFile(join(distDir, 'sitemap.xml'), sitemapXml(manifest.site));

  // Mirror static/ verbatim — site-verification HTML files, well-known endpoints, etc.
  let staticFiles = [];
  try {
    staticFiles = await readdir(staticDir);
  } catch { /* static/ optional */ }
  for (const f of staticFiles) {
    if (f === '.DS_Store') continue;
    await copyFile(join(staticDir, f), join(distDir, f));
  }

  return { distDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build().then(({ distDir }) => console.log(`built ${distDir}`));
}
