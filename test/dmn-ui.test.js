import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

let window;
let document;
let discountSource;

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

function click(el) {
  // el.click() runs activation behavior — a submit button submits its form,
  // which a dispatched plain click Event would not
  el.click();
}

function setSource(value) {
  const sourceEl = document.querySelector('#source');
  sourceEl.value = value;
  sourceEl.dispatchEvent(new window.Event('input'));
}

before(async () => {
  const { build } = await import('../src/build.js');
  await build();
  discountSource = await readFile(join(repoRoot, 'test', 'resources', 'discount.dmn'), 'utf8');
  const html = await readFile(join(repoRoot, 'dist', 'dmn', 'index.html'), 'utf8');
  window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  window.document.write(html);
  document = window.document;
  globalThis.document = document;
  // the app collects form values via FormData(form) — node's built-in
  // (undici) rejects happy-dom elements, so use the window's implementation
  globalThis.FormData = window.FormData;
  // the example loader fetches /dmn/*.dmn — serve them from dist
  globalThis.fetch = async (url) => {
    const content = await readFile(join(repoRoot, 'dist', 'dmn', basename(String(url))), 'utf8');
    return { ok: true, text: async () => content };
  };
  await import('../src/runner/dmn-app.js');
});

test('pasting DMN lists its decisions and renders the decision table', async () => {
  setSource(discountSource);

  const option = await waitFor(() => document.querySelector('#decision option'));
  assert.equal(option.getAttribute('value'), 'discount');
  assert.match(option.textContent, /Discount/);

  const table = await waitFor(() => document.querySelector('#tables table'));
  const ruleRow = table.querySelector('tr[data-rule-id="bigSpenderRule"]');
  assert.ok(ruleRow, 'rendered table should carry rule rows keyed by rule id');
  assert.match(table.textContent, />= 100/, 'input entries should be rendered');
  assert.match(document.querySelector('#tables').textContent, /UNIQUE/, 'hit policy should be rendered');
});

test('evaluating shows the result and highlights matched rules', async () => {
  setSource(discountSource);
  await waitFor(() => document.querySelector('#decision option'));

  document.querySelector('#input-data').value = '{ "total": 250 }';
  click(document.querySelector('#evaluate'));

  const result = await waitFor(() => document.querySelector('#result').textContent && document.querySelector('#result'));
  assert.match(result.textContent, /0\.1/);
  assert.ok(!document.querySelector('#result-block').hidden, 'result block should be revealed');

  const matched = await waitFor(() => document.querySelector('#tables tr[data-rule-id="bigSpenderRule"].matched'));
  assert.ok(matched, 'matched rule row should be highlighted');
  assert.ok(
    !document.querySelector('#tables tr[data-rule-id="regularRule"]').classList.contains('matched'),
    'unmatched rules should not be highlighted',
  );

  const traceDetails = document.querySelector('#trace-details');
  assert.ok(!traceDetails.hidden, 'trace should be revealed after evaluation');
  assert.match(document.querySelector('#trace-body').textContent, /bigSpenderRule/);
});

test('invalid input JSON surfaces an error in the log without evaluating', async () => {
  setSource(discountSource);
  await waitFor(() => document.querySelector('#decision option'));

  document.querySelector('#input-data').value = '{ not json';
  click(document.querySelector('#evaluate'));

  const errorLine = await waitFor(() => document.querySelector('#log li.error'));
  assert.match(errorLine.textContent, /JSON/i);
});

test('registered takeOnce service grants once per evaluation, deterministically across runs', async () => {
  const src = await readFile(join(repoRoot, 'test', 'resources', 'take-once.dmn'), 'utf8');
  setSource(src);
  await waitFor(() => document.querySelectorAll('#decision option').length === 3);
  document.querySelector('#decision').value = 'grantTotal';
  document.querySelector('#input-data').value = '{ "amount": 100 }';

  click(document.querySelector('#evaluate'));
  await waitFor(() => document.querySelector('#result').textContent === '100');

  // services reset per evaluation — a second run must not drain the grant
  click(document.querySelector('#evaluate'));
  await new Promise((r) => setTimeout(r, 50));
  await waitFor(() => document.querySelector('#result').textContent === '100');
});

test('registered exchangeRate service serves async-loaded rates synchronously', async () => {
  const src = await readFile(join(repoRoot, 'test', 'resources', 'exchange.dmn'), 'utf8');
  setSource(src);
  await waitFor(() => document.querySelector('#decision option[value="convertedAmount"]'));
  document.querySelector('#input-data').value = '{ "amount": 100, "currency": "USD" }';
  click(document.querySelector('#evaluate'));
  await waitFor(() => document.querySelector('#result').textContent === '125');
});

test('declared inputs render as typed form fields for the selected decision', async () => {
  const src = await readFile(join(repoRoot, 'test', 'resources', 'exchange.dmn'), 'utf8');
  setSource(src);
  await waitFor(() => document.querySelector('#decision option[value="convertedAmount"]'));

  const form = document.querySelector('#input-form');
  await waitFor(() => !document.querySelector('#declared-inputs').hidden);
  assert.match(
    document.querySelector('#declared-inputs-legend').textContent,
    /Converted amount/,
    'legend should name the form after the selected decision',
  );
  const amountField = form.querySelector('[data-input-name="amount"]');
  assert.ok(amountField, 'amount field not rendered');
  assert.equal(amountField.getAttribute('type'), 'number', 'number typeRef should render a number input');
  const currencyField = form.querySelector('[data-input-name="currency"]');
  assert.ok(currencyField, 'currency field not rendered');
  assert.equal(currencyField.getAttribute('type'), 'text', 'string typeRef should render a text input');
  assert.match(form.textContent, /amount \(number\)/, 'field label should carry name and type');
});

test('form values take precedence over the JSON, empty fields fall back to it', async () => {
  const src = await readFile(join(repoRoot, 'test', 'resources', 'exchange.dmn'), 'utf8');
  setSource(src);
  await waitFor(() => document.querySelector('#decision option[value="convertedAmount"]'));
  await waitFor(() => !document.querySelector('#declared-inputs').hidden);

  // form amount wins over the JSON's amount; empty currency falls back to JSON
  document.querySelector('[data-input-name="amount"]').value = '100';
  document.querySelector('[data-input-name="currency"]').value = '';
  document.querySelector('#input-data').value = '{ "amount": 999, "currency": "USD" }';
  click(document.querySelector('#evaluate'));
  await waitFor(() => document.querySelector('#result').textContent === '125');
});

test('boolean inputs render as a true/false select and coerce on evaluation', async () => {
  setSource(`<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="ApprovalDefinitions" name="Approval" namespace="https://example.com/dmn/approval">
  <inputData id="approvedInput" name="Approved"><variable id="approvedVariable" name="approved" typeRef="boolean" /></inputData>
  <decision id="verdict" name="Verdict">
    <variable id="verdictVariable" name="verdict" typeRef="string" />
    <informationRequirement id="verdictReq"><requiredInput href="#approvedInput" /></informationRequirement>
    <literalExpression id="verdictExpression"><text>if approved then "yes" else "no"</text></literalExpression>
  </decision>
</definitions>`);
  await waitFor(() => document.querySelector('#decision option[value="verdict"]'));
  await waitFor(() => !document.querySelector('#declared-inputs').hidden);

  const field = document.querySelector('[data-input-name="approved"]');
  assert.equal(field.tagName.toLowerCase(), 'select', 'boolean typeRef should render a select');
  field.value = 'true';
  document.querySelector('#input-data').value = '';
  click(document.querySelector('#evaluate'));
  await waitFor(() => document.querySelector('#result').textContent === '"yes"');
});

test('submitting the input form (Enter in a field) evaluates', async () => {
  const src = await readFile(join(repoRoot, 'test', 'resources', 'exchange.dmn'), 'utf8');
  setSource(src);
  await waitFor(() => document.querySelector('#decision option[value="convertedAmount"]'));
  await waitFor(() => !document.querySelector('#declared-inputs').hidden);

  document.querySelector('[data-input-name="amount"]').value = '10';
  document.querySelector('[data-input-name="currency"]').value = 'SEK';
  document.querySelector('#input-data').value = '';
  document.querySelector('#input-form').dispatchEvent(new window.Event('submit'));
  await waitFor(() => document.querySelector('#result').textContent === '115');
});

test('the decision picker defaults to the output decision of a chained model', async () => {
  setSource(`<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="chainDefinitions" name="Chain" namespace="https://example.com/dmn/chain-ui">
  <decision id="first" name="First">
    <variable id="firstVariable" name="first" typeRef="number" />
    <literalExpression id="firstExpression"><text>1</text></literalExpression>
  </decision>
  <decision id="second" name="Second">
    <variable id="secondVariable" name="second" typeRef="number" />
    <informationRequirement id="secondReq"><requiredDecision href="#first" /></informationRequirement>
    <literalExpression id="secondExpression"><text>first + 1</text></literalExpression>
  </decision>
</definitions>`);
  await waitFor(() => document.querySelector('#decision option[value="second"]'));
  assert.equal(
    document.querySelector('#decision').value,
    'second',
    'the dependent (output) decision should be preselected, not the first in document order',
  );
});

test('the input form hides when the source declares no input data', async () => {
  const src = await readFile(join(repoRoot, 'test', 'resources', 'take-once.dmn'), 'utf8');
  setSource(src);
  await waitFor(() => document.querySelector('#decision option[value="grantTotal"]'));
  await waitFor(() => document.querySelector('#declared-inputs').hidden);
});

test('load example fills in source and input data, renders the table and the input form', async () => {
  setSource('');
  document.querySelector('#input-data').value = '';
  click(document.querySelector('#example'));

  await waitFor(() => document.querySelector('#source').value.includes('discount'));
  assert.match(document.querySelector('#input-data').value, /total/);
  await waitFor(() => document.querySelector('#tables tr[data-rule-id="bigSpenderRule"]'));

  // the example declares its total input, so the form shows itself
  await waitFor(() => !document.querySelector('#declared-inputs').hidden);
  const totalField = document.querySelector('[data-input-name="total"]');
  assert.ok(totalField, 'total field not rendered from the example');
  assert.equal(totalField.getAttribute('type'), 'number');
});

test('a decision table without an output column renders square, with a warning', async () => {
  setSource(`<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="defs" name="NoOutput" namespace="https://example.com/dmn/no-output">
  <decision id="discount" name="Discount">
    <decisionTable id="table" hitPolicy="UNIQUE">
      <input id="in1" label="total"><inputExpression id="ie1" typeRef="number"><text>total</text></inputExpression></input>
      <rule id="r1"><inputEntry id="ue1"><text>&gt;= 100</text></inputEntry><outputEntry id="oe1"><text>0.1</text></outputEntry></rule>
    </decisionTable>
  </decision>
</definitions>`);

  // key on the warning: it only exists once the new source has rendered
  const warning = await waitFor(() => document.querySelector('#tables figure[data-decision-id="discount"] .table-warning'));
  const table = document.querySelector('#tables figure[data-decision-id="discount"] table');
  // the orphan outputEntry gets an unnamed output header so the grid stays square
  const headCells = table.querySelectorAll('thead th').length;
  const rowCells = table.querySelectorAll('tbody tr:first-child td').length;
  assert.equal(headCells, rowCells, `header (${headCells}) and rule row (${rowCells}) should align`);

  assert.match(warning.textContent, /no output column/i);
  assert.match(warning.textContent, /evaluation will fail/i);
});

test('a well-formed decision table renders no warning', async () => {
  setSource(discountSource);
  // the previous test's warning disappearing marks the fresh render
  await waitFor(() => !document.querySelector('#tables .table-warning'));
  assert.ok(document.querySelector('#tables figure[data-decision-id="discount"] th.output'), 'complete table should render its output header');
});

/** Dispatch a drop of pseudo-files — `{ name, text() }` is all the app reads. */
function drop(files) {
  const event = new window.Event('drop', { cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: files.map(([name, content]) => ({ name, text: async () => content })) },
  });
  document.querySelector('[data-dropzone]').dispatchEvent(event);
}

async function fixture(name) {
  return readFile(join(repoRoot, 'test', 'resources', name), 'utf8');
}

test('dropping a model and the model it imports at once loads the importing one as source', async () => {
  setSource('');
  drop([
    ['shipping.dmn', await fixture('shipping.dmn')],
    ['order.dmn', await fixture('order.dmn')],
  ]);

  await waitFor(() => document.querySelector('#decision option[value="orderTotal"]'));
  assert.match(document.querySelector('#source').value, /OrderDefinitions/, 'the importing model becomes the source');

  const list = document.querySelector('#imports');
  assert.ok(!list.hidden, 'imports list is revealed for a source with imports');
  const item = list.querySelector('li[data-namespace="https://example.com/dmn/shipping"]');
  assert.equal(item?.dataset.status, 'loaded');
  assert.match(item.textContent, /shipping\.dmn/);

  document.querySelector('#input-data').value = '{ "total": 100, "parcel": { "weight": 12 } }';
  click(document.querySelector('#evaluate'));
  await waitFor(() => document.querySelector('#result').textContent === '150');
  assert.ok(
    document.querySelector('#trace-body tr[data-element-id="shippingFee"]') || /shippingFee/.test(document.querySelector('#trace-body').textContent),
    'the imported decision lands in the trace'
  );
});

test('dropping the imported model after the importing one keeps the source and resolves the import', async () => {
  setSource('');
  drop([['order.dmn', await fixture('order.dmn')]]);
  await waitFor(() => document.querySelector('#decision option[value="orderTotal"]'));
  // the library persists across drops (shipping.dmn may already be in it from an
  // earlier test) — the missing state is covered by the never-dropped namespace test below
  assert.ok(document.querySelector('#imports li[data-namespace="https://example.com/dmn/shipping"]'), 'declared import is listed');

  drop([['shipping.dmn', await fixture('shipping.dmn')]]);
  await waitFor(() => document.querySelector('#imports li[data-status="loaded"]'));
  assert.match(document.querySelector('#source').value, /OrderDefinitions/, 'dropping an imported model must not replace the source');

  document.querySelector('#input-data').value = '{ "total": 1, "parcel": { "weight": 1 } }';
  click(document.querySelector('#evaluate'));
  await waitFor(() => document.querySelector('#result').textContent === '11');
});

test('a declared import that was never dropped is listed as missing and warned about', async () => {
  const unresolved = (await fixture('order.dmn')).replaceAll('https://example.com/dmn/shipping', 'https://example.com/dmn/elsewhere');
  setSource(unresolved);
  const item = await waitFor(() => document.querySelector('#imports li[data-namespace="https://example.com/dmn/elsewhere"]'));
  assert.equal(item.dataset.status, 'missing');
  const warning = await waitFor(() => [...document.querySelectorAll('#log li.warn')].find((li) => /elsewhere/.test(li.textContent)));
  assert.match(warning.textContent, /drop/i, 'the warning should tell the user to drop the file');

  document.querySelector('#input-data').value = '{ "total": 1 }';
  click(document.querySelector('#evaluate'));
  const error = await waitFor(() => [...document.querySelectorAll('#log li.error')].find((li) => /did not resolve/.test(li.textContent)));
  assert.ok(error);
});

test('a source without imports hides the imports list', async () => {
  setSource(discountSource);
  await waitFor(() => document.querySelector('#decision option[value="discount"]'));
  assert.ok(document.querySelector('#imports').hidden);
});
