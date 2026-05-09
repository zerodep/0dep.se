import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dataPath = join(root, 'data', 'projects.json');
const stylesSrc = join(root, 'src', 'styles.css');
const assetsDir = join(root, 'src', 'assets');
const distDir = join(root, 'dist');

const assetFiles = ['logo.png', 'favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png'];

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => escapeMap[c]);

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

function renderHtml(manifest) {
  const { site, groups } = manifest;
  const altDomainsLine = site.altDomains?.length
    ? `<p class="alt-domains">Also reachable at ${site.altDomains.map((d) => `<code>${escape(d)}</code>`).join(', ')}.</p>`
    : '';
  const navLinks = groups
    .map((g) => `<a href="#${escape(g.id)}">${escape(g.title)}</a>`)
    .join(' &middot; ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escape(site.tagline)}">
  <meta name="color-scheme" content="light dark">
  <title>${escape(site.title)} — ${escape(site.tagline)}</title>
  <link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="favicon-192.png">
  <link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <h1><img src="logo.png" alt="${escape(site.title)}" width="320" height="320"></h1>
    <p class="tagline">${escape(site.tagline)}</p>
    <p class="intro">${escape(site.intro)}</p>
    <nav>${navLinks}</nav>
  </header>
  <main>
${groups.map(renderGroup).join('\n')}
  </main>
  <footer>
    ${altDomainsLine}
    <p>
      <a href="${escape(site.githubOrg)}" rel="noopener">github.com/zerodep</a>
      &middot;
      <a href="${escape(site.npmScope)}" rel="noopener">npm/~0dep</a>
      &middot;
      <a href="${escape(site.linkedin)}" rel="noopener">linkedin.com/in/pal-edman</a>
    </p>
    <p class="copy">&copy; Pål Edman &middot; MIT licensed</p>
  </footer>
</body>
</html>
`;
}

export async function build() {
  const manifest = JSON.parse(await readFile(dataPath, 'utf8'));
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), renderHtml(manifest));
  await copyFile(stylesSrc, join(distDir, 'styles.css'));
  for (const f of assetFiles) {
    await copyFile(join(assetsDir, f), join(distDir, f));
  }
  await writeFile(join(distDir, 'CNAME'), manifest.site.primaryDomain + '\n');
  return { distDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build().then(({ distDir }) => console.log(`built ${distDir}`));
}
