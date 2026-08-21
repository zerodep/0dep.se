import { createDmnRunner, evaluateDecision, listRequiredInputs, pickOutputDecision } from './dmn-runner.js';
import { makeTakeHelper } from './take-helper.js';

// --- demo services ---
// FEEL service functions must be synchronous — dmn-elements fails a
// promise-returning service loudly. Async data is integrated by loading it
// beside the run and exposing a sync accessor over the loaded cache.
async function loadExchangeRates() {
  // stands in for an async backend call — a static page cannot fetch cross-origin
  return { EUR: 1, USD: 1.25, GBP: 0.75, SEK: 11.5 };
}
const exchangeRates = {};
const ratesLoaded = loadExchangeRates().then((rates) => Object.assign(exchangeRates, rates));

/** Fresh per evaluation, so repeated Evaluate clicks stay deterministic. */
function demoServices() {
  return {
    takeOnce: makeTakeHelper(1),
    exchangeRate: (currency) => exchangeRates[currency] ?? null,
  };
}

const sourceEl = document.querySelector('#source');
const inputDataEl = document.querySelector('#input-data');
const evaluateBtn = document.querySelector('#evaluate');
const exampleBtn = document.querySelector('#example');
const decisionSelect = document.querySelector('#decision');
const tablesEl = document.querySelector('#tables');
const tablesNote = document.querySelector('#tables-note');
const resultBlock = document.querySelector('#result-block');
const resultEl = document.querySelector('#result');
const traceDetails = document.querySelector('#trace-details');
const traceBody = document.querySelector('#trace-body');
const logDetails = document.querySelector('#log-details');
const logEl = document.querySelector('#log');
const dropzone = document.querySelector('[data-dropzone]');
const inputFormEl = document.querySelector('#input-form');
const declaredInputsEl = document.querySelector('#declared-inputs');
const declaredInputsLegend = document.querySelector('#declared-inputs-legend');
const inputFieldsEl = document.querySelector('#input-fields');

/** @type {{ definition: object, rootElement: object, decisions: { id: string, name?: string, type: string }[] } | null} */
let runner = null;

function logLine(text, { className } = {}) {
  const li = document.createElement('li');
  if (className) li.className = className;
  li.textContent = text;
  logEl.append(li);
  return li;
}

function onLog({ scope, level, message }) {
  logLine(`${scope} ${message}`, { className: level === 'debug' ? 'muted' : level });
}

// --- decision table rendering ---

function renderDecisionTable(table) {
  const el = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.textContent = '#';
  headRow.append(corner);
  for (const input of table.input || []) {
    const th = document.createElement('th');
    th.className = 'input';
    th.textContent = input.label || input.inputExpression?.text || '';
    headRow.append(th);
  }
  for (const output of table.output || []) {
    const th = document.createElement('th');
    th.className = 'output';
    th.textContent = output.label || output.name || '';
    headRow.append(th);
  }
  thead.append(headRow);
  el.append(thead);

  const tbody = document.createElement('tbody');
  for (const [index, rule] of (table.rule || []).entries()) {
    const tr = document.createElement('tr');
    tr.dataset.ruleId = rule.id;
    if (rule.description) tr.title = rule.description;
    const num = document.createElement('td');
    num.className = 'rule-number';
    num.textContent = String(index + 1);
    tr.append(num);
    for (const entry of rule.inputEntry || []) {
      const td = document.createElement('td');
      td.className = 'input';
      td.textContent = entry.text ?? '';
      tr.append(td);
    }
    for (const entry of rule.outputEntry || []) {
      const td = document.createElement('td');
      td.className = 'output';
      td.textContent = entry.text ?? '';
      tr.append(td);
    }
    tbody.append(tr);
  }
  el.append(tbody);
  return el;
}

function renderTables(rootElement) {
  tablesEl.textContent = '';
  if (!rootElement) {
    tablesNote.hidden = false;
    return;
  }
  for (const decision of rootElement.drgElement || []) {
    if (decision.$type !== 'dmn:Decision') continue;
    const logic = decision.decisionLogic;
    const figure = document.createElement('figure');
    figure.className = 'dmn-table';
    figure.dataset.decisionId = decision.id;

    const caption = document.createElement('figcaption');
    caption.textContent = decision.name ? `${decision.name} (${decision.id})` : decision.id;
    if (logic?.$type === 'dmn:DecisionTable') {
      const policy = document.createElement('span');
      policy.className = 'hit-policy';
      const aggregation = logic.aggregation ? ` ${logic.aggregation}` : '';
      policy.textContent = ` — hit policy ${logic.hitPolicy || 'UNIQUE'}${aggregation}`;
      caption.append(policy);
    }
    figure.append(caption);

    if (logic?.$type === 'dmn:DecisionTable') {
      figure.append(renderDecisionTable(logic));
    } else if (logic?.$type === 'dmn:LiteralExpression') {
      const pre = document.createElement('pre');
      pre.textContent = logic.text ?? '';
      figure.append(pre);
    } else {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = logic ? `${logic.$type} — not rendered, still evaluated` : 'no decision logic';
      figure.append(p);
    }
    tablesEl.append(figure);
  }
  tablesNote.hidden = Boolean(tablesEl.childElementCount);
}

function clearEvaluation() {
  resultBlock.hidden = true;
  resultEl.textContent = '';
  traceDetails.hidden = true;
  traceBody.textContent = '';
  for (const el of tablesEl.querySelectorAll('.matched')) el.classList.remove('matched');
  for (const el of tablesEl.querySelectorAll('.evaluated')) el.classList.remove('evaluated');
}

// --- best-effort input form for the selected decision's declared inputs ---

function makeInputField(typeRef) {
  if (typeRef === 'boolean') {
    const select = document.createElement('select');
    for (const value of ['', 'true', 'false']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value || '—';
      select.append(option);
    }
    return select;
  }
  const input = document.createElement('input');
  input.type = typeRef === 'number' ? 'number' : 'text';
  if (input.type === 'number') input.step = 'any';
  return input;
}

/** @type {Map<string, string>} declared typeRef per rendered field name */
const formFieldTypes = new Map();

function updateRequiredInputs() {
  const requiredInputs = runner && decisionSelect.value
    ? listRequiredInputs(runner.rootElement, decisionSelect.value)
    : [];

  // keep values the user already typed when re-rendering (decision switch)
  const previous = new Map(new FormData(inputFormEl));

  formFieldTypes.clear();
  inputFieldsEl.textContent = '';
  for (const { name, typeRef } of requiredInputs) {
    const label = document.createElement('label');
    label.append(typeRef ? `${name} (${typeRef})` : name, ' ');
    const field = makeInputField(typeRef);
    field.name = name;
    field.dataset.inputName = name;
    formFieldTypes.set(name, typeRef || '');
    if (previous.has(name)) field.value = previous.get(name);
    label.append(field);
    inputFieldsEl.append(label);
  }
  const selected = runner?.decisions.find((d) => d.id === decisionSelect.value);
  declaredInputsLegend.textContent = selected ? `${selected.name || selected.id} inputs` : 'Inputs';
  declaredInputsEl.hidden = !requiredInputs.length;
}

/** Filled form fields as input values, coerced by their declared type. */
function collectFormInputs() {
  const values = {};
  for (const [name, raw] of new FormData(inputFormEl)) {
    if (raw === '') continue; // empty — fall back to the JSON
    const typeRef = formFieldTypes.get(name);
    if (typeRef === 'number') {
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`input “${name}” is not a number`);
      values[name] = value;
    } else if (typeRef === 'boolean') {
      values[name] = raw === 'true';
    } else if (typeRef === 'string') {
      values[name] = raw;
    } else {
      // untyped — best effort: JSON where it parses, the raw string otherwise
      try {
        values[name] = JSON.parse(String(raw));
      } catch {
        values[name] = raw;
      }
    }
  }
  return values;
}

decisionSelect.addEventListener('change', updateRequiredInputs);

// The Evaluate button submits the form (Enter in a field works too) — with no
// declared inputs the form is just the toolbar and submit plainly evaluates
inputFormEl.addEventListener('submit', (e) => {
  e.preventDefault();
  evaluate();
});

// --- source parsing ---

let refreshSeq = 0;

async function refreshSource() {
  const seq = ++refreshSeq;
  const source = sourceEl.value;
  runner = null;
  clearEvaluation();
  if (!source.trim()) {
    decisionSelect.textContent = '';
    renderTables(null);
    updateRequiredInputs();
    return;
  }
  try {
    const next = await createDmnRunner(source, { onLog, services: demoServices() });
    if (seq !== refreshSeq) return; // superseded by a newer paste/drop
    runner = next;

    const previous = decisionSelect.value;
    decisionSelect.textContent = '';
    for (const decision of runner.decisions) {
      const option = document.createElement('option');
      option.value = decision.id;
      option.textContent = decision.name ? `${decision.name} (${decision.id})` : decision.id;
      decisionSelect.append(option);
    }
    if (runner.decisions.some((d) => d.id === previous)) decisionSelect.value = previous;
    else if (runner.decisions.length) decisionSelect.value = pickOutputDecision(runner.rootElement);

    renderTables(runner.rootElement);
    updateRequiredInputs();
    if (!runner.decisions.length) {
      logLine('no decisions found in the DMN source', { className: 'warn' });
      logDetails.open = true;
    }
  } catch (err) {
    if (seq !== refreshSeq) return;
    decisionSelect.textContent = '';
    renderTables(null);
    updateRequiredInputs();
    logLine(`not a valid DMN file — ${err?.message || err}`, { className: 'error' });
    logDetails.open = true;
  }
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshSource, 150);
}

// --- evaluate ---

function compactJson(value) {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ');
}

function renderTrace(trace) {
  traceBody.textContent = '';
  for (const entry of trace) {
    const tr = document.createElement('tr');
    const logic = [entry.decisionLogic || entry.type.replace(/^dmn:/, ''), entry.hitPolicy, entry.aggregation]
      .filter(Boolean)
      .join(' · ');
    const cells = [
      entry.name ? `${entry.name} (${entry.id})` : entry.id,
      logic.replace(/^dmn:/, ''),
      entry.matchedRules?.join(', ') ?? '',
      'result' in entry ? compactJson(entry.result) : '',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    traceBody.append(tr);
  }
}

// CSS.escape is a browser global — quote-escape suffices for XML ids elsewhere
const cssEscape = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

function highlightTrace(trace) {
  for (const entry of trace) {
    const figure = tablesEl.querySelector(`figure[data-decision-id="${cssEscape(entry.id)}"]`);
    figure?.classList.add('evaluated');
    for (const ruleId of entry.matchedRules || []) {
      tablesEl.querySelector(`tr[data-rule-id="${cssEscape(ruleId)}"]`)?.classList.add('matched');
    }
  }
}

async function evaluate() {
  evaluateBtn.disabled = true;
  logEl.textContent = '';
  clearEvaluation();
  try {
    if (!runner) throw new Error('no DMN loaded — paste or drop a .dmn file first');
    const decisionId = decisionSelect.value;
    if (!decisionId) throw new Error('the DMN source has no decision to evaluate');

    let input;
    const inputJson = inputDataEl.value.trim();
    if (inputJson) {
      try {
        input = JSON.parse(inputJson);
      } catch (err) {
        throw new Error(`input data is not valid JSON — ${err.message}`);
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('input data must be a JSON object');
      }
    }
    const formInputs = collectFormInputs();
    if (Object.keys(formInputs).length) input = { ...input, ...formInputs };

    await ratesLoaded;
    // swap in fresh service closures so stateful helpers (takeOnce) start
    // over — the environment's services setter replaces the registry in place
    runner.definition.environment.services = demoServices();
    const { result, trace } = await evaluateDecision(runner.definition, decisionId, input);
    resultEl.textContent = result === undefined ? 'undefined' : JSON.stringify(result, null, 2);
    resultBlock.hidden = false;
    renderTrace(trace);
    traceDetails.hidden = false;
    highlightTrace(trace);
  } catch (err) {
    logLine(String((err && err.message) || err), { className: 'error' });
    logDetails.open = true;
  } finally {
    evaluateBtn.disabled = false;
  }
}

// --- wiring ---

sourceEl.addEventListener('input', scheduleRefresh);
sourceEl.addEventListener('paste', scheduleRefresh);

// the example resource is copied to /dmn/ at build time from test/resources
exampleBtn?.addEventListener('click', async () => {
  exampleBtn.disabled = true;
  try {
    const res = await fetch('/dmn/discount.dmn');
    if (!res.ok) throw new Error(`/dmn/discount.dmn ${res.status}`);
    sourceEl.value = await res.text();
    inputDataEl.value = '{ "total": 250 }';
    await refreshSource();
  } catch (err) {
    logLine(`failed to load example — ${err?.message || err}`, { className: 'error' });
    logDetails.open = true;
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
  refreshSource();
});

// offline support — the service worker precaches the page and engine bundle
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/dmn/sw.js').catch(() => {
    /* offline support is progressive enhancement — a failed registration is fine */
  });
}
