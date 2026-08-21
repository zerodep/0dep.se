/**
 * MCP (Model Context Protocol) server exposing the browser runners' engines
 * as agent tools, over the stdio transport — newline-delimited JSON-RPC 2.0,
 * hand-rolled with node built-ins in the zero-dependency spirit of the site.
 *
 * Wire it into an MCP client with: node src/mcp-server.js
 */
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runBpmn } from './runner/bpmn-runner.js';
import { createDmnRunner, evaluateDecision, listRequiredInputs, pickOutputDecision } from './runner/dmn-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));

const LATEST_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', LATEST_PROTOCOL]);

const TOOLS = [
  {
    name: 'run_bpmn',
    description:
      'Execute a BPMN 2.0 diagram with bpmn-elements and return its output. FEEL expressions plus zeebe (Camunda 8) and Camunda 7 extension elements are supported; unregistered service types auto-complete; user and manual tasks are auto-signaled. Business rule tasks evaluate decisions from the dmn sources by decision id (zeebe:calledDecision). Timer events run in real time, so long timers delay the result. A per-activity touch limit guards against infinite loops.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'BPMN 2.0 XML' },
        variables: { type: 'object', description: 'initial environment variables' },
        dmn: { type: 'array', items: { type: 'string' }, description: 'DMN XML sources backing business rule tasks' },
        maxTouches: { type: 'number', description: 'per-activity touch limit before the run is stopped as an infinite loop (default 10)' },
      },
      required: ['source'],
    },
    async handler({ source, variables, dmn, maxTouches }) {
      const { output, stats, stopped } = await runBpmn(source, {
        variables,
        dmn,
        autoSignal: true,
        maxTouches,
      });
      return {
        completed: !stopped,
        output,
        durationMs: Number(stats.duration.toFixed(1)),
        activities: stats.activities.map(({ id, type, name, runs }) => ({ id, type, ...(name && { name }), runs })),
      };
    },
  },
  {
    name: 'evaluate_dmn',
    description:
      'Evaluate a DMN decision with dmn-elements and return the result plus the evaluation trace (elements in completion order with requirement bindings, hit policy, and matched rule ids). Required decisions are walked through the requirements graph. Defaults to the output decision — the one no other decision requires.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'DMN XML (1.3–1.5)' },
        decisionId: { type: 'string', description: 'decision (or decision service) id — defaults to the output decision' },
        input: { type: 'object', description: 'input data values' },
      },
      required: ['source'],
    },
    async handler({ source, decisionId, input }) {
      const { definition, rootElement } = await createDmnRunner(source);
      const decision = decisionId || pickOutputDecision(rootElement);
      if (!decision) throw new Error('the DMN source has no decision to evaluate');
      const { result, trace } = await evaluateDecision(definition, decision, input);
      return { decision, result, trace };
    },
  },
  {
    name: 'list_dmn_decisions',
    description:
      'List the decisions and decision services of a DMN source, each with its declared required inputs (name and typeRef, collected transitively through the requirements graph).',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'DMN XML (1.3–1.5)' },
      },
      required: ['source'],
    },
    async handler({ source }) {
      const { rootElement, decisions } = await createDmnRunner(source);
      return {
        decisions: decisions.map((d) => ({ ...d, requiredInputs: listRequiredInputs(rootElement, d.id) })),
      };
    },
  },
];

const METHODS = {
  initialize({ protocolVersion } = {}) {
    return {
      protocolVersion: KNOWN_PROTOCOLS.has(protocolVersion) ? protocolVersion : LATEST_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'zerodep-runner', title: 'zerodep BPMN & DMN runner', version: pkg.version },
    };
  },
  ping() {
    return {};
  },
  'tools/list'() {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  },
  async 'tools/call'({ name, arguments: args } = {}) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new JsonRpcError(-32602, `unknown tool: ${name}`);
    try {
      const payload = await tool.handler(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      // tool failures are results, not protocol errors — the model should see them
      return { content: [{ type: 'text', text: String(err?.message || err) }], isError: true };
    }
  },
};

class JsonRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function respond(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const { id, method, params } = message;
  if (typeof method !== 'string') return; // a response or malformed — nothing to do
  if (id === undefined) return; // notification (e.g. notifications/initialized)

  const handle = METHODS[method];
  if (!handle) {
    return respond({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
  try {
    respond({ jsonrpc: '2.0', id, result: await handle(params) });
  } catch (err) {
    const code = err instanceof JsonRpcError ? err.code : -32603;
    respond({ jsonrpc: '2.0', id, error: { code, message: String(err?.message || err) } });
  }
});
