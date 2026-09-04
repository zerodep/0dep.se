import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const resources = join(here, 'resources');

let child;
let nextId = 1;
const pending = new Map();

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

function request(method, params) {
  const id = nextId++;
  const response = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000).unref();
  });
  send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
  return response;
}

async function callTool(name, args) {
  const { result, error } = await request('tools/call', { name, arguments: args });
  if (error) throw new Error(error.message);
  return result;
}

const toolJson = (result) => JSON.parse(result.content[0].text);

before(() => {
  child = spawn(process.execPath, [join(repoRoot, 'src', 'mcp-server.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
});

after(() => {
  // close stdin so the server exits on its own (and flushes V8 coverage) instead of being killed
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end();
  return exited;
});

test('initialize handshake declares the tools capability', async () => {
  const { result } = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.ok(result.capabilities.tools, 'server should declare tools capability');
  assert.ok(result.serverInfo.name, 'server should name itself');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

test('tools/list exposes the runner tools with schemas', async () => {
  const { result } = await request('tools/list');
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['evaluate_dmn', 'list_dmn_decisions', 'run_bpmn']);
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} should carry a JSON schema`);
    assert.ok(tool.description, `${tool.name} should be described`);
    assert.ok(tool.inputSchema.required.includes('source'), `${tool.name} should require source`);
  }
});

test('evaluate_dmn evaluates a decision with input data', async () => {
  const source = await readFile(join(resources, 'discount.dmn'), 'utf8');
  const payload = toolJson(await callTool('evaluate_dmn', { source, input: { total: 250 } }));
  assert.equal(payload.decision, 'discount', 'should default to the output decision');
  assert.equal(payload.result, 0.1);
  assert.ok(payload.trace.some((t) => t.matchedRules?.includes('bigSpenderRule')));
});

test('list_dmn_decisions lists decisions with their required inputs', async () => {
  const source = await readFile(join(resources, 'exchange.dmn'), 'utf8');
  const payload = toolJson(await callTool('list_dmn_decisions', { source }));
  const decision = payload.decisions.find((d) => d.id === 'convertedAmount');
  assert.ok(decision, 'decision should be listed');
  assert.deepEqual(decision.requiredInputs, [
    { name: 'amount', typeRef: 'number' },
    { name: 'currency', typeRef: 'string' },
  ]);
});

test('run_bpmn executes a diagram and returns the output', async () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_mcp" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="main" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-user" sourceRef="start" targetRef="approve" />
    <userTask id="approve" />
    <sequenceFlow id="to-task" sourceRef="approve" targetRef="task" />
    <task id="task">
      <extensionElements>
        <zeebe:ioMapping>
          <zeebe:output source="= total * 2" target="doubled" />
        </zeebe:ioMapping>
      </extensionElements>
    </task>
    <sequenceFlow id="to-end" sourceRef="task" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;
  const payload = toolJson(await callTool('run_bpmn', { source, variables: { total: 21 } }));
  assert.equal(payload.completed, true);
  assert.equal(payload.output.doubled, 42, 'user task should be auto-signaled and the run complete');
});

test('run_bpmn evaluates dropped DMN via business rule tasks', async () => {
  const bpmn = await readFile(join(resources, 'pricing.bpmn'), 'utf8');
  const dmn = await readFile(join(resources, 'discount.dmn'), 'utf8');
  const payload = toolJson(await callTool('run_bpmn', {
    source: bpmn,
    dmn: [dmn],
    variables: { order: { total: 250 } },
  }));
  assert.deepEqual(payload.output, { rebate: 0.1 });
});

test('a failing run surfaces as a tool error, not a protocol error', async () => {
  const result = await callTool('run_bpmn', { source: 'not bpmn at all' });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.length, 'error text should explain the failure');
});

test('unknown tool and unknown method yield JSON-RPC errors', async () => {
  const { error: toolError } = await request('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.ok(toolError, 'unknown tool should error');
  const { error: methodError } = await request('no/such-method');
  assert.equal(methodError.code, -32601);
});
