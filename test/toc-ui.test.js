import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

let window;
let document;
const copied = [];

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

function setSource(value) {
  const el = document.querySelector('#source');
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function drop(name, source) {
  const ev = new window.Event('drop', { cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [{ name, text: async () => source }] } });
  document.querySelector('[data-dropzone]').dispatchEvent(ev);
}

before(async () => {
  const { build } = await import('../src/build.js');
  await build();
  const html = await readFile(join(repoRoot, 'dist', 'toc', 'index.html'), 'utf8');
  window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  window.document.write(html);
  document = window.document;
  globalThis.document = document;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => { copied.push(text); } },
  });
  await import('../src/runner/toc-app.js');
});

test('starts with empty results and a hidden download link', () => {
  assert.equal(document.querySelector('#toc-block').textContent, '');
  assert.equal(document.querySelector('#output').value, '');
  assert.ok(document.querySelector('#download').hasAttribute('hidden'));
});

test('typing markdown with markers renders the toc block, the updated document and the pair status', async () => {
  setSource('# Title\n\n<!-- toc -->\n<!-- /toc -->\n\n## Install\n\n## Usage\n');
  const block = await waitFor(() => {
    const el = document.querySelector('#toc-block');
    return el.textContent.includes('[Install](#install)') ? el : null;
  });
  assert.match(block.textContent, /^<!-- toc -->\n\n- \[Install\]\(#install\)\n- \[Usage\]\(#usage\)\n\n<!-- \/toc -->$/);
  assert.match(document.querySelector('#toc-status').textContent, /1 toc updated/);
  const pairs = document.querySelectorAll('#toc-pairs li');
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].textContent, /line 3/);
  assert.match(pairs[0].textContent, /updated/);
  assert.ok(document.querySelector('#output').value.startsWith('# Title\n\n<!-- toc -->\n\n- [Install]'));
  assert.ok(!document.querySelector('#download').hasAttribute('hidden'), 'download link shows once there is output');
  assert.equal(document.querySelector('#download').getAttribute('download'), 'README.md');
});

test('a skipped pair is listed with its reason', async () => {
  setSource('# Title\n\n<!-- toc collapsable -->\n<!-- /toc -->\n\n## Install\n');
  const item = await waitFor(() => {
    const el = document.querySelector('#toc-pairs li');
    return el?.textContent.includes('skipped') ? el : null;
  });
  assert.match(item.textContent, /line 3/);
  assert.match(item.textContent, /unknown TOC option collapsable/);
  assert.ok(item.classList.contains('skipped'));
});

test('markdown without markers lists every heading and honours the wrap options', async () => {
  document.querySelector('#toc-wrap').value = 'collapsed';
  document.querySelector('#toc-summary').value = 'Contents';
  setSource('# Title\n\nIntro\n\n## Install\n');
  const block = await waitFor(() => {
    const el = document.querySelector('#toc-block');
    return el.textContent.includes('<details>') ? el : null;
  });
  assert.match(block.textContent, /^<!-- toc collapsed="Contents" -->\n<details>\n<summary>Contents<\/summary>\n\n- \[Title\]\(#title\)\n  - \[Install\]\(#install\)\n\n<\/details>\n<!-- \/toc -->$/);
  assert.match(document.querySelector('#toc-status').textContent, /No toc markers/);
  assert.equal(document.querySelectorAll('#toc-pairs li').length, 0);
  assert.ok(document.querySelector('#output').value.includes('# Title\n\n<!-- toc collapsed="Contents" -->'));

  // changing an option re-renders without retyping
  document.querySelector('#toc-wrap').value = 'plain';
  document.querySelector('#toc-wrap').dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => document.querySelector('#toc-block').textContent.startsWith('<!-- toc -->\n\n- [Title]'));
});

test('dropping a markdown file fills the source and names the download after the file', async () => {
  drop('CONTRIBUTING.md', '# Contributing\n\n<!-- toc -->\n<!-- /toc -->\n\n## Setup\n');
  await waitFor(() => document.querySelector('#source').value.startsWith('# Contributing'));
  await waitFor(() => document.querySelector('#toc-block').textContent.includes('[Setup](#setup)'));
  assert.equal(document.querySelector('#download').getAttribute('download'), 'CONTRIBUTING.md');
});

test('copy buttons put the block and the document on the clipboard', async () => {
  document.querySelector('#copy-block').click();
  await waitFor(() => copied.length === 1);
  assert.match(copied[0], /^<!-- toc -->\n\n- \[Setup\]\(#setup\)/);
  document.querySelector('#copy-output').click();
  await waitFor(() => copied.length === 2);
  assert.ok(copied[1].startsWith('# Contributing\n\n<!-- toc -->\n\n- [Setup]'));
});

test('clearing the source clears the results and hides the download again', async () => {
  setSource('');
  await waitFor(() => document.querySelector('#toc-block').textContent === '');
  assert.equal(document.querySelector('#output').value, '');
  assert.ok(document.querySelector('#download').hasAttribute('hidden'));
  assert.equal(document.querySelectorAll('#toc-pairs li').length, 0);
});
