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

test('interval dates are shown as ISO code with the local time beside it, including a derived start', async () => {
  setValue('#iso-input', 'R5/P1Y/2025-05-01T13:00:00Z');
  document.querySelector('#iso-form button[type="submit"]').click();
  const result = await waitFor(() => {
    const el = document.querySelector('#iso-result');
    return el.textContent.includes('Parsed as an interval') ? el : null;
  });
  const rows = Object.fromEntries([...result.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling]));
  assert.ok(rows['Start (derived)'], `expected a derived start row, got ${Object.keys(rows).join(', ')}`);
  assert.equal(rows['Start (derived)'].querySelector('code').textContent, '2020-05-01T13:00:00.000Z');
  assert.equal(rows.End.querySelector('code').textContent, '2025-05-01T13:00:00.000Z');
  for (const label of ['Start (derived)', 'End', 'Next start (from now)', 'Expires (from now)']) {
    const dd = rows[label];
    assert.ok(dd, `missing row ${label}`);
    const time = dd.querySelector('time');
    assert.ok(time, `${label} should be wrapped in a time element`);
    const iso = time.querySelector('code');
    assert.equal(time.getAttribute('datetime'), iso.textContent);
    assert.match(iso.textContent, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${label} should hold an ISO timestamp in code`);
    const local = dd.querySelector('.local');
    assert.ok(local, `${label} should show the local time`);
    assert.match(local.textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+$/, 'local time is ISO-like via the sv-SE locale');
    assert.equal(new Date(local.textContent.replace(/ \S+$/, '')).getTime(), new Date(iso.textContent).getTime(), 'local reads back as the same instant');
  }
  await waitFor(() => document.querySelectorAll('#history-list li').length === 2);
});

test('local hours are zero-padded, also before 10 in the morning', async () => {
  setValue('#iso-input', '2024-01-05T07:03:04Z');
  document.querySelector('#iso-form button[type="submit"]').click();
  const result = await waitFor(() => {
    const el = document.querySelector('#iso-result');
    return el.textContent.includes('2024-01-05T07:03:04.000Z') ? el : null;
  });
  const local = result.querySelector('time .local').textContent;
  assert.match(local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+$/, `got ${local}`);
  const hour = new Date('2024-01-05T07:03:04Z').getHours();
  assert.ok(local.includes(` ${String(hour).padStart(2, '0')}:03:04 `), `expected hour ${hour} padded in ${local}`);
  document.querySelector('#history-list li button.history-remove').click();
  await waitFor(() => document.querySelectorAll('#history-list li').length === 2);
});

test('duration expiry uses the same ISO code plus local time format', async () => {
  setValue('#iso-input', 'PT1H');
  document.querySelector('#iso-form button[type="submit"]').click();
  const result = await waitFor(() => {
    const el = document.querySelector('#iso-result');
    return el.textContent.includes('PT1H') ? el : null;
  });
  const rows = Object.fromEntries([...result.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling]));
  const expires = rows['Expires (from now)'].querySelector('time');
  assert.ok(expires, 'expiry should be a time element');
  assert.equal(expires.getAttribute('datetime'), expires.querySelector('code').textContent);
  assert.ok(expires.querySelector('.local'));
  assert.equal(rows.Designators.textContent, 'H=1');
  await waitFor(() => document.querySelectorAll('#history-list li').length === 3);
});

test('invalid ISO input is shown as an error and still lands in history', async () => {
  setValue('#iso-input', '2023-02-29');
  document.querySelector('#iso-form button[type="submit"]').click();
  const result = await waitFor(() => {
    const el = document.querySelector('#iso-result');
    return el.classList.contains('invalid') ? el : null;
  });
  assert.match(result.textContent, /Not a valid ISO 8601 date/);
  assert.match(result.textContent, /out of range 1-28/);
  await waitFor(() => document.querySelectorAll('#history-list li').length === 4);
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

  await waitFor(() => document.querySelectorAll('#history-list li').length === 6);
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
  assert.equal(document.querySelectorAll('#history-list li').length, 6);
});

test('removing one entry and clearing the history', async () => {
  document.querySelector('#history-list li button.history-remove').click();
  await waitFor(() => document.querySelectorAll('#history-list li').length === 5);
  document.querySelector('#history-clear').click();
  await waitFor(() => document.querySelectorAll('#history-list li').length === 0);
  assert.ok(!document.querySelector('#history-empty').hasAttribute('hidden'));
  assert.equal(window.localStorage.getItem('0dep-tools-history'), null);
});
