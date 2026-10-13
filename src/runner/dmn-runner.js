import { DmnModdle } from 'dmn-moddle';
import { Context, Definition, Environment } from 'dmn-elements';

/** Parse DMN XML and return the moddle root element. */
export async function parseDmn(source) {
  const { rootElement } = await new DmnModdle().fromXML(String(source));
  return rootElement;
}

/**
 * The evaluatable DRG elements of a parsed DMN — decisions and decision
 * services, both accepted by Definition#evaluate — as `{ id, name, type }`.
 */
export function listDecisions(rootElement) {
  return (rootElement.drgElement || [])
    .filter((d) => d.$type === 'dmn:Decision' || d.$type === 'dmn:DecisionService')
    .map(({ id, name, $type: type }) => ({ id, name, type }));
}

/**
 * The declared imports of a parsed DMN as `{ name, namespace, locationURI }`.
 * The locationURI is informational only — the runner never fetches it.
 */
export function listImports(rootElement) {
  return (rootElement.import || []).map(({ name, namespace, locationURI }) => ({ name, namespace, locationURI }));
}

/**
 * An in-memory library of parsed DMN models keyed by namespace — the only
 * place declared imports resolve from. Nothing is ever fetched: an import
 * whose namespace has not been added fails the evaluation with a clear
 * "did not resolve" error from dmn-elements.
 * @returns {{
 *   add: (source: string, label?: string) => Promise<{ namespace: string, name?: string, label?: string, source: string, rootElement: object, imports: object[], decisions: object[] }>,
 *   has: (namespace: string) => boolean,
 *   list: () => { namespace: string, name?: string, label?: string }[],
 *   resolveImport: (importDef: { namespace: string }) => object | undefined,
 * }}
 */
export function createImportLibrary() {
  const models = new Map();
  return {
    /** Parse DMN XML and file it under its namespace, replacing an earlier model of the same namespace. */
    async add(source, label) {
      const rootElement = await parseDmn(source);
      const model = {
        namespace: rootElement.namespace,
        name: rootElement.name,
        label,
        source: String(source),
        rootElement,
        imports: listImports(rootElement),
        decisions: listDecisions(rootElement),
      };
      models.set(model.namespace, model);
      return model;
    },
    has: (namespace) => models.has(namespace),
    list: () => [...models.values()].map(({ namespace, name, label }) => ({ namespace, name, label })),
    /** dmn-elements `resolveImport` setting — looks the declared namespace up in the library, never on the network */
    resolveImport: (importDef) => models.get(importDef.namespace)?.rootElement,
  };
}

/**
 * The id of the DRG's output decision — the first decision no other decision
 * requires, falling back to the first decision. Evaluation walks upstream
 * requirements, so the output decision is the one that exercises the whole
 * graph and is almost always the one to evaluate.
 */
export function pickOutputDecision(rootElement) {
  const required = new Set();
  for (const element of rootElement.drgElement || []) {
    for (const requirement of element.informationRequirement || []) {
      const href = requirement.requiredDecision?.href;
      if (href) required.add(href.replace(/^#/, ''));
    }
  }
  const decisions = listDecisions(rootElement);
  return (decisions.find((d) => !required.has(d.id)) || decisions[0])?.id;
}

/**
 * The declared input data a DRG element needs before it can be evaluated, as
 * `{ name, typeRef }` in requirement order — collected transitively through
 * required decisions, deduped by name. For a decision service the bound input
 * decisions count as inputs too, named by their variable. Note this only
 * covers *declared* requirements: expressions are free to reference input
 * values that no inputData element declares.
 */
export function listRequiredInputs(rootElement, drgElementId) {
  const byId = new Map((rootElement.drgElement || []).map((d) => [d.id, d]));
  const resolveRef = (ref) => byId.get(ref?.href?.replace(/^#/, ''));
  const inputs = new Map();
  const visited = new Set();

  function addInput(name, typeRef) {
    if (name && !inputs.has(name)) inputs.set(name, { name, typeRef });
  }

  function visit(element) {
    if (!element || visited.has(element.id)) return;
    visited.add(element.id);
    if (element.$type === 'dmn:InputData') {
      return addInput(element.variable?.name || element.name || element.id, element.variable?.typeRef);
    }
    if (element.$type === 'dmn:DecisionService') {
      for (const ref of element.inputData || []) visit(resolveRef(ref));
      for (const ref of element.inputDecision || []) {
        const decision = resolveRef(ref);
        if (!decision) continue;
        visited.add(decision.id); // bound by the caller — not walked for its own requirements
        addInput(decision.variable?.name || decision.name || decision.id, decision.variable?.typeRef);
      }
      for (const ref of element.outputDecision || []) visit(resolveRef(ref));
      return;
    }
    for (const requirement of element.informationRequirement || []) {
      visit(resolveRef(requirement.requiredInput));
      visit(resolveRef(requirement.requiredDecision));
    }
  }

  visit(byId.get(drgElementId));
  return [...inputs.values()];
}

/**
 * dmn-elements Logger factory forwarding every line to onLog as
 * `{ scope, level, message }` — the shape the runner pages log with.
 */
export function forwardingLogger(onLog) {
  return function Logger(scope) {
    const forward = (level) => (...args) => {
      onLog({ scope, level, message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
    };
    return { debug: forward('debug'), warn: forward('warn'), error: forward('error') };
  };
}

/**
 * Parse DMN XML and wire an evaluatable dmn-elements Definition.
 * @param {string} source DMN XML
 * @param {object} [options]
 * @param {(entry: {scope: string, level: string, message: string}) => void} [options.onLog] receives evaluation log lines
 * @param {Record<string, Function>} [options.services] services exposed to FEEL as `services.<name>`
 * @param {(importDef: { name?: string, namespace: string, locationURI?: string }) => object | undefined} [options.resolveImport]
 *   resolves a declared import to its parsed definitions, e.g. an import library's `resolveImport`;
 *   without it a model with imports fails at evaluation
 * @returns {Promise<{definition: object, rootElement: object, decisions: {id: string, name?: string, type: string}[], imports: {name?: string, namespace: string, locationURI?: string}[]}>}
 *   the definition, the parsed moddle root (for rendering), its decisions, and its declared imports
 */
export async function createDmnRunner(source, options = {}) {
  const { onLog, services, resolveImport } = options;
  const rootElement = await parseDmn(source);
  const environment = new Environment({
    Logger: onLog && forwardingLogger(onLog),
    services,
    settings: resolveImport ? { resolveImport } : undefined,
  });
  const definition = new Definition(new Context(rootElement, environment));
  return { definition, rootElement, decisions: listDecisions(rootElement), imports: listImports(rootElement) };
}

/**
 * Evaluate a decision (or decision service) with the given input data.
 * Resolves `{ result, trace }` — the trace lists evaluated elements in
 * completion order with hit policy resolution and matched rule ids.
 */
export function evaluateDecision(definition, decisionId, input) {
  return definition.trace(decisionId, input);
}
