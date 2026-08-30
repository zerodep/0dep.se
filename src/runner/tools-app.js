import { evaluateIso, evaluateOcr, createHistory } from './tools-lib.js';

const HISTORY_KEY = '0dep-tools-history';
const TOOL_LABELS = { iso: 'ISO 8601', ocr: 'OCR' };

const isoForm = document.querySelector('#iso-form');
const isoInput = document.querySelector('#iso-input');
const isoKind = document.querySelector('#iso-kind');
const isoUtc = document.querySelector('#iso-utc');
const isoResult = document.querySelector('#iso-result');

const ocrForm = document.querySelector('#ocr-form');
const ocrInput = document.querySelector('#ocr-input');
const ocrFixed = document.querySelector('#ocr-fixed');
const ocrFixed2 = document.querySelector('#ocr-fixed2');
const ocrMin = document.querySelector('#ocr-min');
const ocrMax = document.querySelector('#ocr-max');
const ocrResult = document.querySelector('#ocr-result');

const historyList = document.querySelector('#history-list');
const historyEmpty = document.querySelector('#history-empty');
const historyClear = document.querySelector('#history-clear');

let storage = null;
try {
  storage = globalThis.localStorage ?? null;
} catch {
  /* access itself can throw when site data is blocked */
}
const history = createHistory(storage, { key: HISTORY_KEY, max: 50 });

// --- rendering helpers ---

function row(dl, term, value) {
  if (value === undefined || value === null || value === '') return;
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  if (typeof value === 'object' && value.nodeType) dd.append(value);
  else dd.textContent = String(value);
  dl.append(dt, dd);
}

function code(text) {
  const el = document.createElement('code');
  el.textContent = text;
  return el;
}

function localDate(iso) {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
}

function renderResult(container, { ok, headline, invalid = false, details, error }) {
  container.replaceChildren();
  container.hidden = false;
  container.classList.toggle('invalid', !ok || invalid);
  const h = document.createElement('p');
  h.className = 'result-headline';
  h.textContent = headline;
  container.append(h);
  if (error) {
    const p = document.createElement('p');
    p.className = 'result-error';
    p.textContent = error;
    container.append(p);
  }
  if (details) {
    const dl = document.createElement('dl');
    details(dl);
    if (dl.childElementCount) container.append(dl);
  }
}

function boolMark(value) {
  return value ? '✔ pass' : '✖ fail';
}

// --- ISO 8601 ---

function isoOptions() {
  return { kind: isoKind.value, enforceUTC: isoUtc.checked };
}

function runIso(input, options) {
  const result = evaluateIso(input, options);
  if (!result.ok) {
    renderResult(isoResult, { ok: false, headline: `Not a valid ISO 8601 ${result.kind}`, error: result.error });
    return result;
  }
  const headline = { interval: 'Parsed as an interval', duration: 'Parsed as a duration', date: 'Parsed as a date' }[result.kind];
  renderResult(isoResult, {
    ok: true,
    headline,
    details(dl) {
      switch (result.kind) {
        case 'interval':
          row(dl, 'Normalized', code(result.normalized));
          row(dl, 'Components', `${result.flags.join(' + ')} (type ${result.type})`);
          row(dl, 'Repeat', result.repeat);
          row(dl, 'Start', result.start && code(result.start));
          row(dl, 'Duration', result.duration && code(result.duration));
          row(dl, 'End', result.end && code(result.end));
          row(dl, 'Next start (from now)', result.startAt && `${result.startAt} — ${localDate(result.startAt)}`);
          row(dl, 'Expires (from now)', result.expireAt && `${result.expireAt} — ${localDate(result.expireAt)}`);
          break;
        case 'duration':
          row(dl, 'Normalized', code(result.normalized));
          row(dl, 'Sign', result.sign < 0 ? 'negative (−)' : 'positive');
          row(dl, 'Designators', Object.entries(result.designators).map(([k, v]) => `${k}=${v}`).join(', '));
          row(dl, 'Milliseconds (from now)', result.milliseconds);
          row(dl, 'Expires (from now)', `${result.expireAt} — ${localDate(result.expireAt)}`);
          break;
        default:
          row(dl, 'UTC', code(result.date));
          row(dl, 'Local', localDate(result.date));
          row(dl, 'Epoch ms', result.epoch);
          row(dl, 'ISO week', code(result.week));
          row(dl, 'Weekday (UTC)', result.weekday);
      }
    },
  });
  return result;
}

isoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = isoInput.value.trim();
  const options = isoOptions();
  const result = runIso(input, options);
  if (!input) return;
  history.push({
    tool: 'iso',
    input,
    options,
    summary: result.ok ? result.kind : `invalid ${result.kind}`,
  });
  renderHistory();
});

// --- OCR ---

function ocrMode() {
  return ocrForm.querySelector('input[name="ocr-mode"]:checked')?.value ?? 'validate';
}

function ocrOptions() {
  const options = { mode: ocrMode() };
  if (ocrFixed.value) options.fixedLength = Number(ocrFixed.value);
  if (ocrFixed2.value) options.fixedLength2 = Number(ocrFixed2.value);
  if (ocrMin.value) options.minLength = Number(ocrMin.value);
  if (ocrMax.value) options.maxLength = Number(ocrMax.value);
  return options;
}

function runOcr(input, options) {
  const result = evaluateOcr(input, options);
  if (!result.ok) {
    renderResult(ocrResult, {
      ok: false,
      headline: options.mode === 'generate' ? 'Could not generate a reference' : 'Could not validate',
      error: result.error,
    });
    return result;
  }
  if (result.mode === 'generate') {
    renderResult(ocrResult, {
      ok: true,
      headline: 'Generated OCR reference',
      details(dl) {
        const strong = document.createElement('strong');
        strong.className = 'ocr-number';
        strong.textContent = result.numbers;
        row(dl, 'Reference', strong);
        row(dl, 'Length', result.length);
        row(dl, 'Length control digit', result.lengthControl);
        row(dl, 'Control digit', result.control);
        row(dl, 'Checksum', result.sum);
        if (result.fixedLength) row(dl, 'Fixed length', result.fixedLength);
      },
    });
    return result;
  }
  renderResult(ocrResult, {
    ok: true,
    invalid: !result.valid,
    headline: result.valid ? 'Valid OCR reference (modulus 10)' : 'Invalid OCR reference',
    error: result.error,
    details(dl) {
      row(dl, 'Length', result.length);
      row(dl, 'Expected control digit', result.control);
      row(dl, 'Checksum', result.sum);
      row(dl, 'Soft', boolMark(result.algorithms.soft));
      row(dl, 'Hard', boolMark(result.algorithms.hard));
      row(dl, 'Variable length', boolMark(result.algorithms.variableLength));
      if ('fixedLength' in result.algorithms) row(dl, 'Fixed length', boolMark(result.algorithms.fixedLength));
    },
  });
  return result;
}

ocrForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = ocrInput.value.trim();
  const options = ocrOptions();
  const result = runOcr(input, options);
  if (!input) return;
  let summary;
  if (!result.ok) summary = 'error';
  else if (result.mode === 'generate') summary = `→ ${result.numbers}`;
  else summary = result.valid ? 'valid' : 'invalid';
  history.push({ tool: 'ocr', input, options, summary: `${options.mode} ${summary}` });
  renderHistory();
});

// --- history ---

function restore(entry) {
  if (entry.tool === 'iso') {
    isoInput.value = entry.input;
    isoKind.value = entry.options.kind ?? 'auto';
    isoUtc.checked = Boolean(entry.options.enforceUTC);
    isoForm.requestSubmit ? isoForm.requestSubmit() : isoForm.dispatchEvent(new Event('submit', { cancelable: true }));
    isoForm.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  } else if (entry.tool === 'ocr') {
    ocrInput.value = entry.input;
    const mode = entry.options.mode ?? 'validate';
    const radio = ocrForm.querySelector(`input[name="ocr-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    ocrFixed.value = entry.options.fixedLength ?? '';
    ocrFixed2.value = entry.options.fixedLength2 ?? '';
    ocrMin.value = entry.options.minLength ?? '';
    ocrMax.value = entry.options.maxLength ?? '';
    ocrForm.requestSubmit ? ocrForm.requestSubmit() : ocrForm.dispatchEvent(new Event('submit', { cancelable: true }));
    ocrForm.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }
}

function describeOptions(entry) {
  const parts = [];
  if (entry.tool === 'iso') {
    if (entry.options.kind && entry.options.kind !== 'auto') parts.push(entry.options.kind);
    if (entry.options.enforceUTC) parts.push('UTC');
  } else {
    if (entry.options.fixedLength) parts.push(`fixed ${[entry.options.fixedLength, entry.options.fixedLength2].filter(Boolean).join('/')}`);
    if (entry.options.minLength) parts.push(`min ${entry.options.minLength}`);
    if (entry.options.maxLength) parts.push(`max ${entry.options.maxLength}`);
  }
  return parts.join(', ');
}

function renderHistory() {
  const entries = history.list();
  historyList.replaceChildren();
  historyEmpty.hidden = entries.length > 0;
  historyClear.disabled = entries.length === 0;
  for (const entry of entries) {
    const li = document.createElement('li');
    li.dataset.id = entry.id;
    li.dataset.tool = entry.tool;

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'history-restore';
    restoreBtn.title = 'Restore and run again';
    const tag = document.createElement('span');
    tag.className = 'history-tool';
    tag.textContent = TOOL_LABELS[entry.tool] ?? entry.tool;
    const inputEl = document.createElement('code');
    inputEl.className = 'history-input';
    inputEl.textContent = entry.input;
    restoreBtn.append(tag, ' ', inputEl);
    li.append(restoreBtn);

    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const opts = describeOptions(entry);
    meta.textContent = [entry.summary, opts, localDate(entry.at)].filter(Boolean).join(' · ');
    li.append(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'history-remove';
    removeBtn.setAttribute('aria-label', 'Remove from history');
    removeBtn.title = 'Remove from history';
    removeBtn.textContent = '×';
    li.append(removeBtn);

    historyList.append(li);
  }
}

historyList.addEventListener('click', (e) => {
  const target = e.target;
  const li = target?.closest?.('li[data-id]');
  if (!li) return;
  const entry = history.list().find((x) => x.id === li.dataset.id);
  if (!entry) return;
  if (target.closest('button.history-remove')) {
    history.remove(entry.id);
    renderHistory();
  } else if (target.closest('button.history-restore')) {
    restore(entry);
  }
});

historyClear.addEventListener('click', () => {
  history.clear();
  renderHistory();
});

renderHistory();

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/tools/sw.js').catch(() => {
    /* offline support is progressive enhancement — a failed registration is fine */
  });
}
