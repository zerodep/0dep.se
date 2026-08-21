import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build as bundleJs } from 'esbuild';

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
  csp = '',
}) {
  const baseUrl = `https://${site.primaryDomain}`;
  const url = `${baseUrl}${path}`;
  const imageAbs = ogImage.startsWith('http') ? ogImage : `${baseUrl}${ogImage}`;
  const keywordsTag = keywords ? `\n  <meta name="keywords" content="${escape(keywords)}">` : '';
  const cspTag = csp ? `\n  <meta http-equiv="Content-Security-Policy" content="${escape(csp)}">` : '';
  return `  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">${cspTag}
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
  if (p.link) {
    links.push(`<a href="${escape(p.link.href)}">${escape(p.link.label)}</a>`);
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
  const groupLink = g.link
    ? `\n        <p class="group-link"><a href="${escape(g.link.href)}">${escape(g.link.label)}</a></p>`
    : '';
  return `    <section class="group" id="${escape(g.id)}">
      <header class="group-header">
        <h2>${escape(g.title)}</h2>
        <p>${escape(g.description)}</p>${groupLink}
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
  const navLinks = `${groupNav} &middot; <a href="/run/">Run BPMN</a> &middot; <a href="/dmn/">Run DMN</a> &middot; <a href="/about/">About</a>`;
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

const runFaq = [
  {
    q: 'Is any data transmitted when I run a diagram?',
    a: 'No data is transmitted. This is a static page and the engine runs entirely in your browser — diagrams, DMN files, and variables never leave your machine. The page makes no network requests with your content, and its Content-Security-Policy blocks requests to any other origin. The site is open source, so you can verify this in the code.',
  },
  {
    q: 'Does it work offline?',
    a: 'Yes. After your first visit a service worker caches the page and the engine, so you can run BPMN diagrams entirely offline — which is also an easy way to see for yourself that nothing is transmitted.',
  },
  {
    q: 'Which BPMN elements are supported?',
    a: 'Tasks, service, script, user and manual tasks, gateways, sequence flow conditions, timers and boundary events. FEEL expressions and zeebe (Camunda 8) extension elements are evaluated, Camunda 7 service and script tasks run through, and business rule tasks evaluate DMN 1.3 decision tables.',
  },
  {
    q: 'What engine powers the runner?',
    a: 'bpmn-elements wired with @0dep/bpmn-extensions and dmn-elements — the same open-source building blocks behind bpmn-engine on npm — with the diagram drawn by bpmn-js.',
  },
];

function ldRun(site) {
  const baseUrl = `https://${site.primaryDomain}`;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'zerodep BPMN runner',
      url: `${baseUrl}/run/`,
      description: 'Run BPMN 2.0 diagrams online — a free in-browser BPMN and DMN engine.',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any — runs in the web browser',
      browserRequirements: 'Requires JavaScript',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Execute BPMN 2.0 diagrams client-side',
        'FEEL expressions and zeebe (Camunda 8) extension elements',
        'Camunda 7 diagrams run through',
        'DMN 1.3 decision tables for business rule tasks',
        'Step mode, signalable user tasks, cancellable timers',
        'Diagram rendering with live markers and taken counters',
        'Execution log and performance stats',
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: runFaq.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    },
  ];
}

function renderRun(site) {
  const faq = runFaq
    .map(
      ({ q, a }) => `        <div><dt>${escape(q)}</dt><dd>${escape(a)}</dd></div>`,
    )
    .join('\n');
  const ldBlocks = ldRun(site).map(jsonLd).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
${head({
    site,
    title: `Run BPMN diagrams online — browser BPMN 2.0 & DMN engine — ${site.title}`,
    description:
      'Free online BPMN runner: paste or drop a BPMN 2.0 diagram and execute it in your browser — step through the run, signal user tasks, evaluate DMN decision tables. No upload, no account. Powered by bpmn-elements with FEEL and zeebe extensions.',
    keywords:
      'run bpmn online, online bpmn runner, bpmn simulator, bpmn runner, execute bpmn diagram, test bpmn online, bpmn 2.0 engine, browser bpmn engine, dmn decision table online, online bpmn and dmn runner, feel expressions, camunda 7, camunda 8, zeebe, bpmn-elements, bpmn-engine',
    path: '/run/',
    // everything is self-hosted; unsafe-inline styles for bpmn-js inline style attributes
    csp: "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'",
  })}
  <link rel="stylesheet" href="/run/diagram-js.css">
  <link rel="stylesheet" href="/run/bpmn-js.css">
</head>
<body>
  <header class="site-header run-header">
    <p class="back"><a href="/">&larr; back to ${escape(site.title)}</a></p>
    <h1>Run a BPMN diagram</h1>
    <p class="tagline">Paste or drop BPMN 2.0 XML and execute it right here in the browser &mdash; <a href="https://github.com/paed01/bpmn-elements" rel="noopener">bpmn-elements</a> wired with <a href="https://github.com/zerodep/bpmn-extensions" rel="noopener">@0dep/bpmn-extensions</a>, drawn with <a href="https://github.com/bpmn-io/bpmn-js" rel="noopener">bpmn-js</a>.</p>
  </header>
  <main class="run">
    <section class="run-canvas" aria-label="Diagram">
      <div class="run-toolbar">
        <p class="run-actions">
          <button id="run" type="button">Run</button>
          <button id="step" type="button" disabled>Step</button>
          <button id="example" type="button" class="secondary">Load example</button>
        </p>
        <p class="run-options">
          <label><input type="checkbox" id="step-mode"> Step through the run</label>
          <label><input type="checkbox" id="bypass"> Run through manual and user tasks</label>
          <label>Loop guard
            <select id="max-touches">
              <option value="10" selected>10</option>
              <option value="20">20</option>
              <option value="50">50</option>
            </select>
            touches</label>
        </p>
      </div>
      <div id="canvas"></div>
      <p id="canvas-note" class="hint">Load a diagram with BPMN DI to see it here. Running elements light up, and clicking an element shows its properties.</p>
      <div id="properties" hidden>
        <h3 id="properties-title"></h3>
        <p id="properties-taken"></p>
        <pre id="properties-body"></pre>
      </div>
      <details class="run-log" id="stats-details" hidden>
        <summary>Execution stats <span id="run-state"></span></summary>
        <p id="stats-total"></p>
        <table id="stats">
          <thead>
            <tr><th>Activity</th><th>Type</th><th>Runs</th><th>Total ms</th></tr>
          </thead>
          <tbody id="stats-body"></tbody>
        </table>
      </details>
      <details class="run-log" id="log-details">
        <summary>Execution log</summary>
        <ul id="log"></ul>
        <pre id="output"></pre>
      </details>
    </section>
    <section class="run-dmn" data-dmn-dropzone aria-label="Decisions">
      <h2>Decisions</h2>
      <ul id="dmn-list"></ul>
      <p class="hint">Drop <code>.dmn</code> files here &mdash; business rule tasks call their decisions by decision id (<code>zeebe:calledDecision</code>), executed with <a href="https://github.com/zerodep/dmn-elements" rel="noopener">dmn-elements</a>. Just the decisions? <a href="/dmn/">Evaluate DMN standalone</a>.</p>
    </section>
    <section class="run-input" data-dropzone>
      <label for="source">BPMN 2.0 XML &mdash; paste it, or drop a <code>.bpmn</code> file on this panel</label>
      <textarea id="source" spellcheck="false" placeholder="&lt;definitions xmlns=&quot;http://www.omg.org/spec/BPMN/20100524/MODEL&quot; ...&gt;"></textarea>
      <label for="variables">Initial environment variables (JSON)</label>
      <textarea id="variables" class="variables" spellcheck="false" placeholder='{ "order": { "total": 199 } }'></textarea>
      <p class="hint">FEEL expressions plus zeebe and camunda 7 extension elements are supported. Unregistered service task types and foreign script formats run through, and waiting manual and user tasks get a Signal button in the log unless bypassed. The helpers <code>takeOnce</code> and <code>takeTwice</code> make circular flows terminate: use <code>= takeOnce()</code> in a loop-back condition, or <code>takeTwice</code> as a service task type and <code>= taken</code> on the flow.</p>
    </section>
    <section class="run-about">
      <h2>A free online BPMN engine, in your browser</h2>
      <p>This page executes BPMN 2.0 diagrams entirely client-side: paste XML straight from your modeler or drop a <code>.bpmn</code> file, run or step through the flow, signal waiting tasks, and watch elements light up with taken counters &mdash; your diagrams never leave the browser. Business rule tasks evaluate DMN decision tables dropped alongside.</p>
      <dl class="faq">
${faq}
      </dl>
      <p class="source">Don&rsquo;t take our word for it &mdash; the whole site is open source: <a href="${escape(site.sourceRepo)}" rel="noopener">${escape(site.sourceRepo.replace('https://', ''))}</a>.</p>
    </section>
  </main>
${footer(site)}
${ldBlocks}
  <script type="module" src="/run/app.js"></script>
</body>
</html>
`;
}

const dmnFaq = [
  {
    q: 'Is any data transmitted when I evaluate a decision?',
    a: 'No data is transmitted. This is a static page and the decision engine runs entirely in your browser — DMN files and input data never leave your machine. The page makes no network requests with your content, and its Content-Security-Policy blocks requests to any other origin. The site is open source, so you can verify this in the code.',
  },
  {
    q: 'Does it work offline?',
    a: 'Yes. After your first visit a service worker caches the page and the engine, so you can evaluate DMN decisions entirely offline — which is also an easy way to see for yourself that nothing is transmitted.',
  },
  {
    q: 'Which DMN constructs are supported?',
    a: 'DMN 1.3 decision tables and literal expressions, all boxed expressions including the DMN 1.4 additions (conditional, filter, for, some, every), decision services, business knowledge models, item definitions, and multi-model imports. FEEL expressions and unary tests are evaluated with feelin. The engine passes DMN TCK compliance level 2 in full.',
  },
  {
    q: 'What engine powers the evaluator?',
    a: 'dmn-elements — the same open-source decision engine that backs business rule tasks on the BPMN runner and in the bpmn-engine ecosystem — with the DMN XML parsed by dmn-moddle.',
  },
];

function ldDmn(site) {
  const baseUrl = `https://${site.primaryDomain}`;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'zerodep DMN runner',
      url: `${baseUrl}/dmn/`,
      description: 'Evaluate DMN decisions online — a free in-browser DMN decision engine.',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any — runs in the web browser',
      browserRequirements: 'Requires JavaScript',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Evaluate DMN 1.3 decisions client-side, chained through the decision requirements graph',
        'Decision tables rendered with matched-rule highlighting',
        'Best-effort input form generated from declared input data',
        'Evaluation trace with hit policy resolution and requirement bindings',
        'FEEL expressions and unary tests via feelin',
        'DMN 1.4 boxed expressions, decision services, and business knowledge models',
        'Works with DMN exported from Camunda Modeler and dmn-js based tools',
        'Evaluation log',
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: dmnFaq.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    },
  ];
}

function renderDmn(site) {
  const faq = dmnFaq
    .map(
      ({ q, a }) => `        <div><dt>${escape(q)}</dt><dd>${escape(a)}</dd></div>`,
    )
    .join('\n');
  const ldBlocks = ldDmn(site).map(jsonLd).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
${head({
    site,
    title: `Evaluate DMN decisions online — browser DMN runner & decision engine — ${site.title}`,
    description:
      'Free online DMN runner and evaluator: paste or drop a DMN file and evaluate decisions in your browser — decision tables with matched-rule highlighting, chained decisions through the requirements graph, evaluation trace, FEEL expressions. No upload, no account. Powered by dmn-elements.',
    keywords:
      'evaluate dmn online, online dmn runner, dmn evaluator, dmn decision table online, run dmn online, dmn simulator, test dmn decision, camunda dmn, decision requirements graph, drd, dmn 1.3, dmn 1.4, dmn 1.5, decision table hit policy, browser dmn engine, decision engine online, feel expression evaluator, online bpmn and dmn runner, dmn-elements, bpmn-engine',
    path: '/dmn/',
    // everything is self-hosted, and unlike /run/ nothing injects inline styles
    csp: "default-src 'self'; object-src 'none'; base-uri 'self'",
  })}
</head>
<body>
  <header class="site-header run-header">
    <p class="back"><a href="/">&larr; back to ${escape(site.title)}</a></p>
    <h1>Evaluate a DMN decision</h1>
    <p class="tagline">Paste or drop a DMN file and evaluate decisions right here in the browser &mdash; powered by <a href="https://github.com/zerodep/dmn-elements" rel="noopener">dmn-elements</a>, parsed with <a href="https://github.com/bpmn-io/dmn-moddle" rel="noopener">dmn-moddle</a>. Whole diagrams? <a href="/run/">Run BPMN</a>.</p>
  </header>
  <main class="run">
    <section class="run-canvas dmn-view" aria-label="Decisions">
      <form id="input-form">
        <div class="run-toolbar">
          <p class="run-actions">
            <button id="evaluate" type="submit">Evaluate</button>
            <button id="example" type="button" class="secondary">Load example</button>
          </p>
          <p class="run-options">
            <label>Decision
              <select id="decision"></select>
            </label>
          </p>
        </div>
        <fieldset id="declared-inputs" hidden>
          <legend id="declared-inputs-legend">Inputs</legend>
          <p class="hint">The selected decision declares these inputs &mdash; filled fields win over the input data JSON, empty ones fall back to it.</p>
          <div id="input-fields"></div>
        </fieldset>
      </form>
      <div id="tables"></div>
      <p id="tables-note" class="hint">Load DMN to see its decision tables here. After an evaluation the matched rules light up.</p>
      <div id="result-block" hidden>
        <h2>Result</h2>
        <pre id="result"></pre>
      </div>
      <details class="run-log" id="trace-details" hidden>
        <summary>Evaluation trace</summary>
        <table id="trace">
          <thead>
            <tr><th>Element</th><th>Logic</th><th>Matched rules</th><th>Result</th></tr>
          </thead>
          <tbody id="trace-body"></tbody>
        </table>
      </details>
      <details class="run-log" id="log-details">
        <summary>Evaluation log</summary>
        <ul id="log"></ul>
      </details>
    </section>
    <section class="run-input" data-dropzone>
      <label for="source">DMN XML &mdash; paste it, or drop a <code>.dmn</code> file on this panel</label>
      <textarea id="source" spellcheck="false" placeholder="&lt;definitions xmlns=&quot;https://www.omg.org/spec/DMN/20191111/MODEL/&quot; ...&gt;"></textarea>
      <label for="input-data">Input data (JSON)</label>
      <textarea id="input-data" class="variables" spellcheck="false" placeholder='{ "total": 250 }'></textarea>
      <p class="hint">The selected decision evaluates with the JSON above as input data &mdash; required decisions are walked bottom-up, and every evaluated element lands in the trace with its matched rules and result. Two demo services are registered for FEEL to call: <code>services.takeOnce("key")</code> returns true once per evaluation, and <code>services.exchangeRate("USD")</code> reads rates loaded asynchronously beside the run &mdash; service functions themselves must be synchronous.</p>
    </section>
    <section class="run-about">
      <h2>A free online DMN engine, in your browser</h2>
      <p>This page evaluates DMN decisions entirely client-side: paste XML straight from your modeler or drop a <code>.dmn</code> file, pick a decision, and evaluate it with your input data &mdash; matched decision table rules light up and the trace shows how the result came to be. Chained decisions evaluate through the decision requirements graph (DRG): required decisions are walked bottom-up and the output decision is preselected, so files exported from Camunda Modeler or any dmn-js based tool run as-is. Your decisions never leave the browser, and after the first visit the page works offline. Need the process around the decisions? The <a href="/run/">online BPMN runner</a> executes whole diagrams, business rule tasks included.</p>
      <dl class="faq">
${faq}
      </dl>
      <p class="source">Don&rsquo;t take our word for it &mdash; the whole site is open source: <a href="${escape(site.sourceRepo)}" rel="noopener">${escape(site.sourceRepo.replace('https://', ''))}</a>.</p>
    </section>
  </main>
${footer(site)}
${ldBlocks}
  <script type="module" src="/dmn/app.js"></script>
</body>
</html>
`;
}

/**
 * Cache-first service worker so /run/ works offline. The cache name carries a
 * content hash — a new deploy installs a fresh cache and drops the old one.
 */
function renderServiceWorker(assets, version, prefix = 'run') {
  return `const CACHE = '${prefix}-${version}';
const ASSETS = ${JSON.stringify(assets, null, 1)};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('${prefix}-')).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
`;
}

function render404(site) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Page not found">
  <meta name="robots" content="noindex">
  <meta name="color-scheme" content="light dark">
  <title>Page not found — ${escape(site.title)}</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header notfound">
    <h1>404</h1>
    <p class="tagline">That page doesn&rsquo;t exist.</p>
    <p class="back"><a href="/">&larr; back to ${escape(site.title)}</a></p>
  </header>
</body>
</html>
`;
}

/**
 * llms.txt — a markdown site summary for AI crawlers and answer engines
 * (https://llmstxt.org). Generated from the manifest so it stays in sync.
 */
function llmsTxt(manifest) {
  const { site, groups } = manifest;
  const base = `https://${site.primaryDomain}`;
  const groupSections = groups.map((g) => {
    const projects = g.projects
      .map((p) => `- [${p.name}](${p.repo}): ${p.description}`)
      .join('\n');
    return `## ${g.title}\n\n${projects}`;
  });
  return `# ${site.title}

> ${site.seoDescription || site.tagline}

## Pages

- [Run BPMN online](${base}/run/): execute BPMN 2.0 diagrams entirely in the browser — FEEL expressions, zeebe and camunda 7 extensions, DMN decision tables via business rule tasks. Nothing is uploaded.
- [Evaluate DMN online](${base}/dmn/): evaluate DMN decisions in the browser — decision tables with matched-rule highlighting, chained decisions through the requirements graph, evaluation trace.
- [About](${base}/about/): the maintainer behind the packages.

${groupSections.join('\n\n')}
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
    <loc>${base}/run/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${base}/dmn/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
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
  await mkdir(join(distDir, 'run'), { recursive: true });
  await mkdir(join(distDir, 'dmn'), { recursive: true });

  await writeFile(join(distDir, 'index.html'), renderHome(manifest));
  await writeFile(join(distDir, 'about', 'index.html'), renderAbout(profile, manifest.site));
  await writeFile(join(distDir, 'run', 'index.html'), renderRun(manifest.site));
  await bundleJs({
    // out: 'app' keeps the public URL /run/app.js despite the entry file's name
    entryPoints: [{ in: join(root, 'src', 'runner', 'bpmn-app.js'), out: 'app' }],
    outdir: join(distDir, 'run'),
    bundle: true,
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    format: 'esm',
    platform: 'browser',
    minify: true,
    logLevel: 'silent',
  });
  for (const f of ['diagram-js.css', 'bpmn-js.css']) {
    await copyFile(join(root, 'node_modules', 'bpmn-js', 'dist', 'assets', f), join(distDir, 'run', f));
  }
  // example diagrams for the Load example button — single source of truth in test/resources
  for (const f of ['pricing.bpmn', 'discount.dmn']) {
    await copyFile(join(root, 'test', 'resources', f), join(distDir, 'run', f));
  }

  // offline support: precache everything /run/ needs, versioned by content
  const chunkFiles = (await readdir(join(distDir, 'run', 'chunks'))).filter((f) => f.endsWith('.js'));
  const runAssets = [
    '/run/',
    '/run/index.html',
    '/run/app.js',
    ...chunkFiles.map((f) => `/run/chunks/${f}`),
    '/run/diagram-js.css',
    '/run/bpmn-js.css',
    '/run/pricing.bpmn',
    '/run/discount.dmn',
    '/styles.css',
    '/favicon-32.png',
    '/favicon-192.png',
  ];
  const swVersion = crc32(
    Buffer.concat(await Promise.all([
      readFile(join(distDir, 'run', 'app.js')),
      readFile(join(distDir, 'run', 'index.html')),
    ])),
  ).toString(16);
  await writeFile(join(distDir, 'run', 'sw.js'), renderServiceWorker(runAssets, swVersion));

  // the /dmn/ evaluator page — same treatment, its own bundle and offline cache
  await writeFile(join(distDir, 'dmn', 'index.html'), renderDmn(manifest.site));
  await bundleJs({
    entryPoints: [join(root, 'src', 'runner', 'dmn-app.js')],
    outfile: join(distDir, 'dmn', 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    logLevel: 'silent',
  });
  await copyFile(join(root, 'test', 'resources', 'discount.dmn'), join(distDir, 'dmn', 'discount.dmn'));
  const dmnAssets = [
    '/dmn/',
    '/dmn/index.html',
    '/dmn/app.js',
    '/dmn/discount.dmn',
    '/styles.css',
    '/favicon-32.png',
    '/favicon-192.png',
  ];
  const dmnSwVersion = crc32(
    Buffer.concat(await Promise.all([
      readFile(join(distDir, 'dmn', 'app.js')),
      readFile(join(distDir, 'dmn', 'index.html')),
    ])),
  ).toString(16);
  await writeFile(join(distDir, 'dmn', 'sw.js'), renderServiceWorker(dmnAssets, dmnSwVersion, 'dmn'));
  await writeFile(join(distDir, '404.html'), render404(manifest.site));
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
  await writeFile(join(distDir, 'llms.txt'), llmsTxt(manifest));

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
