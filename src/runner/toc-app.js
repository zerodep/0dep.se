import { evaluateToc } from './toc-lib.js';

const DEFAULT_NAME = 'README.md';

const dropzone = document.querySelector('[data-dropzone]');
const sourceEl = document.querySelector('#source');
const wrapEl = document.querySelector('#toc-wrap');
const summaryEl = document.querySelector('#toc-summary');
const generateBtn = document.querySelector('#generate');
const exampleBtn = document.querySelector('#example');
const statusEl = document.querySelector('#toc-status');
const pairsEl = document.querySelector('#toc-pairs');
const blockEl = document.querySelector('#toc-block');
const outputEl = document.querySelector('#output');
const copyBlockBtn = document.querySelector('#copy-block');
const copyOutputBtn = document.querySelector('#copy-output');
const downloadEl = document.querySelector('#download');

let fileName = DEFAULT_NAME;
let objectUrl = null;

function wrapOptions() {
  const summary = summaryEl.value.trim();
  switch (wrapEl.value) {
    case 'collapsible':
      return { collapsible: summary || true };
    case 'collapsed':
      return { collapsed: summary || true };
    default:
      return {};
  }
}

function refresh() {
  const source = sourceEl.value;
  if (!source.trim()) {
    render(null);
    return;
  }
  render(evaluateToc(source, wrapOptions()));
}

function render(result) {
  pairsEl.replaceChildren();
  if (objectUrl) {
    URL.revokeObjectURL?.(objectUrl);
    objectUrl = null;
  }
  if (!result) {
    statusEl.textContent = '';
    statusEl.hidden = true;
    blockEl.textContent = '';
    outputEl.value = '';
    downloadEl.hidden = true;
    downloadEl.removeAttribute('href');
    copyBlockBtn.disabled = true;
    copyOutputBtn.disabled = true;
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = result.summary;
  statusEl.classList.toggle('muted', !result.changed);
  for (const pair of result.pairs) {
    const li = document.createElement('li');
    li.className = pair.status.replace(/\s+/g, '-');
    const line = document.createElement('code');
    line.textContent = `line ${pair.line}`;
    li.append(line, `: ${pair.message}`);
    pairsEl.append(li);
  }
  blockEl.textContent = result.block;
  outputEl.value = result.output;
  copyBlockBtn.disabled = !result.block;
  copyOutputBtn.disabled = !result.output;
  updateDownload(result);
}

function updateDownload(result) {
  const canBlob = typeof Blob === 'function' && typeof URL?.createObjectURL === 'function';
  if (!canBlob || !result.output || !result.block) {
    downloadEl.hidden = true;
    downloadEl.removeAttribute('href');
    return;
  }
  objectUrl = URL.createObjectURL(new Blob([result.output], { type: 'text/markdown;charset=utf-8' }));
  downloadEl.href = objectUrl;
  downloadEl.setAttribute('download', fileName);
  downloadEl.hidden = false;
}

async function copy(button, text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    flash(button, 'Copy failed');
  }
}

function flash(button, label) {
  const original = button.dataset.label ?? button.textContent;
  button.dataset.label = original;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// --- wiring ---

let pending = null;
function scheduleRefresh() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    refresh();
  }, 0);
}

sourceEl.addEventListener('input', scheduleRefresh);
sourceEl.addEventListener('paste', scheduleRefresh);
wrapEl.addEventListener('change', refresh);
summaryEl.addEventListener('input', scheduleRefresh);
generateBtn.addEventListener('click', refresh);
copyBlockBtn.addEventListener('click', () => copy(copyBlockBtn, blockEl.textContent));
copyOutputBtn.addEventListener('click', () => copy(copyOutputBtn, outputEl.value));

// the example resource is copied to /toc/ at build time from test/resources
exampleBtn?.addEventListener('click', async () => {
  exampleBtn.disabled = true;
  try {
    const res = await fetch('/toc/example.md');
    if (!res.ok) throw new Error(`/toc/example.md ${res.status}`);
    sourceEl.value = await res.text();
    fileName = 'example.md';
    refresh();
  } catch (err) {
    statusEl.hidden = false;
    statusEl.textContent = `failed to load example — ${err?.message || err}`;
  } finally {
    exampleBtn.disabled = false;
  }
});

function wireDropzone(zone, onFiles) {
  for (const eventName of ['dragover', 'dragenter']) {
    zone.addEventListener(eventName, (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });
  }
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  });
}

wireDropzone(dropzone, async ([file]) => {
  sourceEl.value = await file.text();
  fileName = file.name || DEFAULT_NAME;
  refresh();
});

render(null);

// offline support — the service worker precaches the page and the bundle
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/toc/sw.js').catch(() => {
    /* offline support is progressive enhancement — a failed registration is fine */
  });
}
