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

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

function setValue(selector, value) {
  const el = document.querySelector(selector);
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

before(async () => {
  const { build } = await import('../src/build.js');
  await build();
  const html = await readFile(join(repoRoot, 'dist', 'tools', 'index.html'), 'utf8');
  window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  window.document.write(html);
  document = window.document;
  globalThis.document = document;
  globalThis.localStorage = window.localStorage;
  globalThis.FormData = window.FormData;
  await import('../src/runner/tools-app.js');
});

test('history list starts empty with the empty hint', () => {
  assert.equal(document.querySelectorAll('#history-list li').length, 0);
  assert.ok(!document.querySelector('#history-empty').hasAttribute('hidden'));
});

test('parsing an ISO 8601 duration renders the result and records history', async () => {
  setValue('#iso-input', 'P1Y2M3DT4H');
  document.querySelector('#iso-form button[type="submit"]').click();

  const result = await waitFor(() => {
    const el = document.querySelector('#iso-result');
    return el.textContent.includes('duration') ? el : null;
  });
  assert.match(result.textContent, /Milliseconds/, 'milliseconds should be shown');
  assert.match(result.textContent, /P1Y2M3DT4H/, 'normalized duration should be shown');
  assert.ok(!result.classList.contains('invalid'));

  const item = await waitFor(() => document.querySelector('#history-list li'));
  assert.match(item.textContent, /P1Y2M3DT4H/);
  assert.match(item.textContent, /ISO 8601/);
  assert.ok(document.querySelector('#history-empty').hasAttribute('hidden'));

  const stored = JSON.parse(window.localStorage.getItem('0dep-tools-history'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].input, 'P1Y2M3DT4H');
});

test('invalid ISO input is shown as an error and still lands in history', async () => {
  setValue('#iso-input', '2023-02-29');
  document.querySelector('#iso-form button[type="submit"]').click();
  const result = await waitFor(() => {
    const el = document.querySelector('#iso-result');
    return el.classList.contains('invalid') ? el : null;
  });
  assert.match(result.textContent, /Invalid ISO 8601 date/);
  await waitFor(() => document.querySelectorAll('#history-list li').length === 2);
});

test('generating an OCR renders the number, validating checks it', async () => {
  setValue('#ocr-input', 'Customer007:Date2019-12-24:Amount$200');
  document.querySelector('input[name="ocr-mode"][value="generate"]').click();
  document.querySelector('#ocr-form button[type="submit"]').click();
  const result = await waitFor(() => {
    const el = document.querySelector('#ocr-result');
    return el.textContent.includes('0072019122420063') ? el : null;
  });
  assert.match(result.textContent, /length control/i);

  setValue('#ocr-input', '00720191224200637');
  document.querySelector('input[name="ocr-mode"][value="validate"]').click();
  document.querySelector('#ocr-form button[type="submit"]').click();
  const invalid = await waitFor(() => {
    const el = document.querySelector('#ocr-result');
    return el.classList.contains('invalid') ? el : null;
  });
  assert.match(invalid.textContent, /invalid/i);

  await waitFor(() => document.querySelectorAll('#history-list li').length === 4);
  const first = document.querySelector('#history-list li');
  assert.match(first.textContent, /OCR/);
  assert.match(first.textContent, /00720191224200637/);
});

test('clicking a history entry restores the form and re-runs it', async () => {
  // the oldest entry is the duration parse
  const items = document.querySelectorAll('#history-list li');
  const oldest = items[items.length - 1];
  oldest.querySelector('button.history-restore').click();
  await waitFor(() => document.querySelector('#iso-input').value === 'P1Y2M3DT4H');
  await waitFor(() => document.querySelector('#iso-result').textContent.includes('Parsed as a duration'));
  // re-running moves the entry to the top instead of duplicating it
  await waitFor(() => document.querySelector('#history-list li').textContent.includes('P1Y2M3DT4H'));
  assert.equal(document.querySelectorAll('#history-list li').length, 4);
});

test('removing one entry and clearing the history', async () => {
  document.querySelector('#history-list li button.history-remove').click();
  await waitFor(() => document.querySelectorAll('#history-list li').length === 3);
  document.querySelector('#history-clear').click();
  await waitFor(() => document.querySelectorAll('#history-list li').length === 0);
  assert.ok(!document.querySelector('#history-empty').hasAttribute('hidden'));
  assert.equal(window.localStorage.getItem('0dep-tools-history'), null);
});
