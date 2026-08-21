import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const resources = join(dirname(fileURLToPath(import.meta.url)), 'resources');

import { createDmnRunner, evaluateDecision, listRequiredInputs } from '../src/runner/dmn-runner.js';
import { makeTakeHelper } from '../src/runner/take-helper.js';

const SERVICE_DMN_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="feeDefinitions" name="Fees" namespace="https://example.com/dmn/fee">
  <decision id="fee" name="Fee">
    <variable id="feeVariable" name="fee" typeRef="number" />
    <literalExpression id="feeExpression"><text>services.rate(total) * total</text></literalExpression>
  </decision>
</definitions>`;

test('createDmnRunner parses DMN and lists decisions with id, name, and type', async () => {
  const dmn = await readFile(join(resources, 'discount.dmn'), 'utf8');
  const { decisions, definition, rootElement } = await createDmnRunner(dmn);
  assert.deepEqual(decisions, [{ id: 'discount', name: 'Discount', type: 'dmn:Decision' }]);
  assert.ok(definition, 'runner should carry a definition');
  assert.ok(rootElement, 'runner should carry the parsed moddle root for rendering');
});

test('createDmnRunner rejects on non-DMN input', async () => {
  await assert.rejects(createDmnRunner('not dmn at all'));
});

test('evaluateDecision resolves result and trace with hit policy and matched rules', async () => {
  const dmn = await readFile(join(resources, 'discount.dmn'), 'utf8');
  const { definition } = await createDmnRunner(dmn);

  const { result, trace } = await evaluateDecision(definition, 'discount', { total: 250 });
  assert.equal(result, 0.1);
  const entry = trace.find((t) => t.id === 'discount');
  assert.ok(entry, 'trace should carry the evaluated decision');
  assert.equal(entry.hitPolicy, 'UNIQUE');
  assert.deepEqual(entry.matchedRules, ['bigSpenderRule']);

  const { result: small } = await evaluateDecision(definition, 'discount', { total: 50 });
  assert.equal(small, 0);
});

test('evaluateDecision rejects for an unknown decision id', async () => {
  const dmn = await readFile(join(resources, 'discount.dmn'), 'utf8');
  const { definition } = await createDmnRunner(dmn);
  await assert.rejects(evaluateDecision(definition, 'no-such-decision'), /no-such-decision/);
});

test('evaluation logs are forwarded through onLog', async () => {
  const dmn = await readFile(join(resources, 'discount.dmn'), 'utf8');
  const entries = [];
  const { definition } = await createDmnRunner(dmn, { onLog: (entry) => entries.push(entry) });
  await evaluateDecision(definition, 'discount', { total: 250 });

  assert.ok(entries.length > 0, 'expected DMN log entries');
  for (const entry of entries) {
    assert.equal(typeof entry.scope, 'string');
    assert.equal(typeof entry.message, 'string');
    assert.ok(['debug', 'warn', 'error'].includes(entry.level), `unexpected level: ${entry.level}`);
  }
  assert.ok(
    entries.some((e) => /rules matched/.test(e.message)),
    `expected a decision table resolution entry, got: ${entries.map((e) => e.message).join(' | ')}`,
  );
});

test('decisions can invoke registered services', async () => {
  const { definition } = await createDmnRunner(SERVICE_DMN_SOURCE, {
    services: { rate: (total) => (total >= 100 ? 0.1 : 0.05) },
  });
  const { result } = await evaluateDecision(definition, 'fee', { total: 200 });
  assert.equal(result, 20);
});

test('take-once.dmn: takeOnce grants only the first caller across the requirement graph', async () => {
  const dmn = await readFile(join(resources, 'take-once.dmn'), 'utf8');
  const { definition } = await createDmnRunner(dmn, {
    services: { takeOnce: makeTakeHelper(1) },
  });
  const { result, trace } = await evaluateDecision(definition, 'grantTotal', { amount: 100 });
  assert.equal(result, 100, 'only one of the two grant decisions should take the grant');
  const grants = trace.filter((t) => t.id === 'firstGrant' || t.id === 'secondGrant').map((t) => t.result);
  assert.deepEqual(grants.sort((a, b) => b - a), [100, 0]);
});

test('exchange.dmn: a sync service backed by async-loaded data resolves the rate', async () => {
  const dmn = await readFile(join(resources, 'exchange.dmn'), 'utf8');
  // FEEL services are synchronous — async data loads beside the run, the
  // service is a sync accessor over the loaded cache
  const rates = await Promise.resolve({ USD: 1.25 });
  const { definition } = await createDmnRunner(dmn, {
    services: { exchangeRate: (currency) => rates[currency] ?? null },
  });
  const { result } = await evaluateDecision(definition, 'convertedAmount', { amount: 100, currency: 'USD' });
  assert.equal(result, 125);
});

test('listRequiredInputs collects a decision’s declared input data with name and type', async () => {
  const dmn = await readFile(join(resources, 'exchange.dmn'), 'utf8');
  const { rootElement } = await createDmnRunner(dmn);
  const inputs = listRequiredInputs(rootElement, 'convertedAmount');
  assert.deepEqual(inputs, [
    { name: 'amount', typeRef: 'number' },
    { name: 'currency', typeRef: 'string' },
  ]);
});

test('listRequiredInputs walks required decisions transitively and dedupes', async () => {
  const dmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="ChainDefinitions" name="Chain" namespace="https://example.com/dmn/chain">
  <inputData id="ageInput" name="Age"><variable id="ageVariable" name="age" typeRef="number" /></inputData>
  <decision id="category" name="Category">
    <variable id="categoryVariable" name="category" typeRef="string" />
    <informationRequirement id="categoryReq"><requiredInput href="#ageInput" /></informationRequirement>
    <literalExpression id="categoryExpression"><text>if age &gt;= 18 then "adult" else "minor"</text></literalExpression>
  </decision>
  <decision id="fee" name="Fee">
    <variable id="feeVariable" name="fee" typeRef="number" />
    <informationRequirement id="feeReqCategory"><requiredDecision href="#category" /></informationRequirement>
    <informationRequirement id="feeReqAge"><requiredInput href="#ageInput" /></informationRequirement>
    <literalExpression id="feeExpression"><text>if category = "adult" then 100 else 50</text></literalExpression>
  </decision>
</definitions>`;
  const { rootElement } = await createDmnRunner(dmn);
  const inputs = listRequiredInputs(rootElement, 'fee');
  assert.deepEqual(inputs, [{ name: 'age', typeRef: 'number' }], 'age required via both paths should appear once');
});

test('listRequiredInputs returns empty for decisions without declared input data', async () => {
  const dmn = await readFile(join(resources, 'take-once.dmn'), 'utf8');
  const { rootElement } = await createDmnRunner(dmn);
  assert.deepEqual(listRequiredInputs(rootElement, 'grantTotal'), []);
});

test('the discount example declares its total input for the form', async () => {
  const dmn = await readFile(join(resources, 'discount.dmn'), 'utf8');
  const { rootElement } = await createDmnRunner(dmn);
  assert.deepEqual(listRequiredInputs(rootElement, 'discount'), [{ name: 'total', typeRef: 'number' }]);
});

test('a promise-returning service fails the evaluation loudly', async () => {
  const dmn = await readFile(join(resources, 'exchange.dmn'), 'utf8');
  // the parameter matters — feelin parses the signature for arity and
  // resolves a mismatched invocation to null without calling the service
  const { definition } = await createDmnRunner(dmn, {
    services: { exchangeRate: async (currency) => (currency ? 1.25 : 0) },
  });
  await assert.rejects(
    evaluateDecision(definition, 'convertedAmount', { amount: 100, currency: 'USD' }),
    /synchronous/,
  );
});
