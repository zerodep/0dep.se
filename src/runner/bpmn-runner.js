import { BpmnModdle } from 'bpmn-moddle';
import * as elements from 'bpmn-elements';
import { parseDmn, listDecisions, forwardingLogger } from './dmn-runner.js';
import { makeTakeHelper } from './take-helper.js';
import { Context as DmnContext, Definition as DmnDefinition, Environment as DmnEnvironment } from 'dmn-elements';
import { Serializer, TypeResolver } from 'moddle-context-serializer';
import { extensions, extendFn, FeelExpressions, FeelScripts } from '@0dep/bpmn-extensions';
import zeebeSchema from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import camundaSchema from 'camunda-bpmn-moddle/resources/camunda.json' with { type: 'json' };

const typeResolver = TypeResolver(elements);

const CAMUNDA7_NS = 'http://camunda.org/schema/1.0/bpmn';

/**
 * The zeebe and camunda 7 moddle schemas both extend the same BPMN types with
 * an identical `modelerTemplate` property, so moddle refuses to register them
 * together. A diagram targets one platform, so pick the schema its xmlns
 * declares — zeebe when both or neither appear.
 */
function createModdle(source) {
  if (source.includes(CAMUNDA7_NS) && !source.includes('http://camunda.org/schema/zeebe/1.0')) {
    return new BpmnModdle({ camunda: camundaSchema });
  }
  return new BpmnModdle({ zeebe: zeebeSchema });
}

const BYPASSABLE_TYPES = new Set(['bpmn:UserTask', 'bpmn:ManualTask']);

/**
 * Wrap user-supplied services so any unregistered service type resolves to a
 * stub that completes the job with no variables — a pasted diagram with
 * arbitrary zeebe:taskDefinition types should run to completion, not stall.
 */
function stubbedServices(services = {}, onServiceCall) {
  return new Proxy({ ...services }, {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name !== 'string') return undefined;
      return function serviceStub(elementApi, callback) {
        onServiceCall?.(name, elementApi);
        callback(null, {});
      };
    },
  });
}

/**
 * FeelScripts, but scripts it cannot compile (camunda 7 groovy/JavaScript
 * bodies, or any script task without a zeebe:script) run through instead of
 * emitting a fatal "unsupported script format" error.
 */
function passThroughScripts() {
  const feel = FeelScripts();
  const passThrough = {
    execute(_scope, callback) {
      callback(null);
    },
  };
  return {
    register(activity) {
      return feel.register(activity);
    },
    getScript(scriptFormat, activity) {
      const script = feel.getScript(scriptFormat, activity);
      if (script) return script;
      // Only script tasks pass through — sequence-flow conditions and event
      // definitions also come through here and must fall back to expression
      // evaluation, not be swallowed by a script that returns nothing.
      if (activity.type === 'bpmn:ScriptTask') return passThrough;
      return undefined;
    },
  };
}

/**
 * Per-expression language pick, keyed on the body's own marker: a leading `=`
 * means FEEL (zeebe convention), `${...}` means a camunda 7 style template
 * resolved by bpmn-elements' default engine (property paths and service calls
 * against `environment`/message — not arbitrary operators), anything else is
 * a literal.
 */
function hybridExpressions() {
  const feel = FeelExpressions();
  const templates = elements.Expressions();
  return {
    resolveExpression(expression, context, expressionFnContext) {
      if (typeof expression === 'string' && !feel.isExpression(expression) && templates.hasExpression(expression)) {
        return templates.resolveExpression(expression, context, expressionFnContext);
      }
      return feel.resolveExpression(expression, context);
    },
    isExpression: (text) => feel.isExpression(text) || templates.isExpression(text),
    hasExpression: (text) => feel.hasExpression(text) || templates.hasExpression(text),
  };
}

/**
 * A sequence-flow condition whose body carries neither expression marker
 * degrades to a constant truthy string — almost always a mistake, so surface
 * it before the run starts.
 */
function warnLiteralConditions(context, onWarning) {
  const feel = FeelExpressions();
  const templates = elements.Expressions();
  for (const flow of context.getSequenceFlows()) {
    const body = flow.behaviour?.conditionExpression?.body;
    if (typeof body !== 'string' || !body.trim()) continue;
    if (feel.isExpression(body) || templates.hasExpression(body)) continue;
    onWarning(
      `condition on <${flow.id}> is neither FEEL (leading =) nor a \${...} template — the flow is always taken`,
    );
  }
}

/**
 * List the decisions (and decision services) of a DMN source as `{ id, name }`,
 * for presenting what a dropped file provides.
 */
export async function listDmnDecisions(source) {
  return listDecisions(await parseDmn(source)).map(({ id, name }) => ({ id, name }));
}

/**
 * Build one environment service per decision (and decision service) in the
 * given DMN sources — a business rule task's `zeebe:calledDecision` dispatches
 * to a service named by its decision id. The decision evaluates with the
 * current process variables (and any input mapping) as input; later sources
 * win on id clashes. The BPMN environment's own services ride along so FEEL
 * inside a decision can invoke them as `services.<name>`.
 * Evaluation logs are forwarded to onDmnLog as `{ scope, level, message }`.
 */
async function dmnDecisionServices(dmnSources, onDmnLog, services) {
  const Logger = onDmnLog && forwardingLogger(onDmnLog);

  const decisionServices = {};
  for (const source of dmnSources) {
    const rootElement = await parseDmn(source);
    const definition = new DmnDefinition(new DmnContext(rootElement, new DmnEnvironment({ Logger, services })));
    for (const { id } of listDecisions(rootElement)) {
      decisionServices[id] = function evaluateDecision(executionMessage, callback) {
        const input = { ...this?.environment?.variables, ...executionMessage?.content?.input };
        onDmnLog?.({ scope: 'dmn:decision', level: 'debug', message: `<${id}> input ${JSON.stringify(input, null, 1).replace(/\n\s*/g, ' ')}` });
        definition.evaluate(id, input, callback);
      };
    }
  }
  return decisionServices;
}

/**
 * Parse BPMN 2.0 XML (zeebe and camunda 7 namespaces supported) and wire a
 * runnable bpmn-elements Definition with @0dep/bpmn-extensions.
 * Camunda 7 service tasks (class, delegateExpression, external topic) run
 * through via bpmn-elements' dummy service.
 * @param {string} source BPMN 2.0 XML
 * @param {object} [options]
 * @param {object} [options.variables] initial environment variables
 * @param {object} [options.services] named services (by zeebe job type or expression)
 * @param {boolean} [options.step] run in step mode — activities pause until stepped with stepDefinition()
 * @param {string[]} [options.dmn] DMN sources whose decisions back business rule tasks (matched by decision id)
 * @param {(entry: {scope: string, level: string, message: string}) => void} [options.onDmnLog] receives DMN evaluation log lines
 * @param {(message: string) => void} [options.onWarning] receives diagram lint warnings (e.g. literal flow conditions)
 * @param {(name: string, elementApi: object) => void} [options.onServiceCall] called when an unregistered service type is auto-stubbed
 */
export async function createDefinition(source, options = {}) {
  const { variables, onServiceCall, step, dmn, onDmnLog, onWarning } = options;
  const takeOnce = makeTakeHelper(1);
  const takeTwice = makeTakeHelper(2);
  const userServices = { takeOnce, takeTwice, ...options.services };
  const services = {
    ...(dmn?.length ? await dmnDecisionServices(dmn, onDmnLog, userServices) : undefined),
    ...userServices,
  };

  const moddleContext = await createModdle(String(source)).fromXML(String(source));
  const serialized = Serializer(moddleContext, typeResolver, extendFn);
  const context = new elements.Context(serialized);

  if (!context.getExecutableProcesses().length) {
    throw new Error('diagram has no executable process (set isExecutable="true")');
  }

  if (onWarning) warnLiteralConditions(context, onWarning);

  const definition = new elements.Definition(context, {
    settings: { enableDummyService: true, step: Boolean(step) },
    expressions: hybridExpressions(),
    scripts: passThroughScripts(),
    extensions: { flowExtensions: extensions },
    // the take helpers ride along as variables so FEEL conditions can invoke
    // them; user variables win on name clashes
    variables: { takeOnce, takeTwice, ...variables },
    services,
  });

  // Environment#clone spreads options.services into a fresh object, which would
  // strip the proxy's get trap — install it on the registry symbol afterwards
  // instead. Subsequent clones pass the registry by reference, so process and
  // activity environments resolve stubs too.
  definition.environment[Symbol.for('services')] = stubbedServices(services, onServiceCall);

  return definition;
}

/**
 * Run a wired Definition. Every bubbled engine event is forwarded to onEvent
 * as `{ event, id, type, name }`; wait events also carry the element `api`
 * so the caller can signal (user tasks, signals, message catches).
 * With `autoSignal`, waiting user and manual tasks are signaled immediately
 * (the forwarded entry is marked `autoSignaled`); other waits still need the api.
 * Resolves `{ output, events, definition, stats }` when the definition leaves
 * (with `stopped: true` when it was stopped instead of running to the end) —
 * stats being `{ duration, activities: [{ id, type, name, runs, totalMs }] }`
 * where totalMs sums enter-to-leave per activity (waiting time included) over
 * all its runs.
 * Diagrams can be circular — when an activity's run counters show it has been
 * touched more than `maxTouches` times the definition is stopped and the run
 * rejects, instead of looping forever. Step mode is exempt: every advance is a
 * deliberate click, so the user decides when a circular run has gone on long enough.
 * @param {object} definition
 * @param {object} [options]
 * @param {(entry: {event: string, id: string, type: string, name?: string, api?: object, autoSignaled?: boolean}) => void} [options.onEvent]
 * @param {boolean} [options.autoSignal] bypass user and manual tasks
 * @param {number} [options.maxTouches] per-activity touch limit before the run is considered an infinite loop, defaults to 10
 */
export function runDefinition(definition, options = {}) {
  const { onEvent, autoSignal, maxTouches = 10 } = options;
  return new Promise((resolve, reject) => {
    const events = [];
    const consumerTag = 'runner-events';

    /** @type {Map<string, number>} enter timestamp per activity run (by executionId) */
    const runStarts = new Map();
    /** @type {Map<string, {id: string, type: string, name?: string, runs: number, totalMs: number}>} */
    const perActivity = new Map();
    let startedAt;

    const settle = (fn, value) => {
      definition.broker.cancel(consumerTag);
      fn(value);
    };

    definition.broker.subscribeTmp(
      'event',
      '#',
      (routingKey, message) => {
        const { id, type, name, executionId, accepts } = message.content;
        const entry = { event: routingKey, id, type, name };
        // which api messages the element acts on while postponed — drives
        // whether Signal/Cancel make sense for this entry
        if (accepts) entry.accepts = accepts;
        if (routingKey === 'activity.timer') {
          entry.timeout = message.content.timeout;
          entry.api = definition.getApi(message);
        }

        if (routingKey === 'activity.leave') {
          const enteredAt = runStarts.get(executionId);
          if (enteredAt !== undefined) {
            runStarts.delete(executionId);
            let activityStats = perActivity.get(id);
            if (!activityStats) perActivity.set(id, (activityStats = { id, type, name, runs: 0, totalMs: 0 }));
            activityStats.runs += 1;
            activityStats.totalMs += performance.now() - enteredAt;
          }
        }

        if (routingKey === 'activity.enter') {
          if (!definition.environment.settings.step) {
            const counters = definition.getApi(message)?.owner?.counters;
            if (counters && counters.taken + counters.discarded >= maxTouches) {
              // settle first — it cancels the consumer, so the definition.stop
              // event emitted by stop() cannot re-enter and resolve as stopped
              settle(reject, new Error(`possible infinite loop — <${id}> touched more than ${maxTouches} times, run stopped`));
              definition.stop();
              return;
            }
          }
          runStarts.set(executionId, performance.now());
        }

        let signalNext;
        if (routingKey.endsWith('.wait')) {
          entry.api = definition.getApi(message);
          if (autoSignal && BYPASSABLE_TYPES.has(type)) {
            entry.autoSignaled = true;
            signalNext = entry.api;
          }
        }

        events.push(entry);
        onEvent?.(entry);
        signalNext?.signal();

        if (routingKey === 'definition.error') {
          settle(reject, message.content.error?.source?.content?.error || message.content.error || new Error(`${id} errored`));
        } else if (routingKey === 'definition.leave' || routingKey === 'definition.stop') {
          const stats = {
            duration: performance.now() - startedAt,
            activities: [...perActivity.values()],
          };
          settle(resolve, {
            ...(routingKey === 'definition.stop' && { stopped: true }),
            output: definition.environment.output,
            events,
            definition,
            stats,
          });
        }
      },
      { noAck: true, consumerTag },
    );

    try {
      startedAt = performance.now();
      definition.run();
    } catch (err) {
      settle(reject, err);
    }
  });
}

/**
 * Advance a step-mode run: nudge each postponed element of every running
 * process one run-step. Returns true if anything advanced.
 */
export function stepDefinition(definition) {
  let advanced = false;
  for (const bp of definition.getRunningProcesses() || []) {
    if (stepPostponed(bp.getPostponed(), bp)) advanced = true;
  }
  return advanced;
}

function stepPostponed(postponed, activityScope) {
  let advanced = false;
  for (const api of postponed) {
    const owner = api.owner;

    // a sub-process carries its own postponed elements with their own run
    // queues — recurse before nudging the sub-process activity itself. Its
    // getPostponed() includes apis for the sub-process's own execution, which
    // would recurse forever — only descend into actual inner elements. The
    // inner process executions resolve endpoint activities of parked inner
    // loop-back flows.
    if (owner.isSubProcess && typeof api.getPostponed === 'function') {
      const inner = api.getPostponed().filter((sub) => sub.owner !== owner);
      if (stepPostponed(inner, subProcessScope(owner))) advanced = true;
    }

    if (typeof owner.next === 'function') {
      if (owner.next()) advanced = true;
      continue;
    }

    // a looped sequence flow parks postponed until its endpoints drain their
    // run queues (e.g. the target's unacked run.leave from its previous run)
    // — flows have no next(), so nudge the activities on either end
    if (!activityScope) continue;
    for (const activityId of [owner.sourceId, owner.targetId]) {
      const activity = activityId && activityScope.getActivityById(activityId);
      if (activity?.next?.()) advanced = true;
    }
  }

  return advanced;
}

/** Activity lookup across a sub-process's running executions. */
function subProcessScope(subProcess) {
  const executions = subProcess.execution?.source?.executions || [];
  return {
    getActivityById(activityId) {
      for (const pe of executions) {
        const activity = pe.getActivityById(activityId);
        if (activity) return activity;
      }
      return undefined;
    },
  };
}

/**
 * Convenience: parse, wire, and run a BPMN source in one call.
 * Takes the union of createDefinition and runDefinition options.
 */
export async function runBpmn(source, options = {}) {
  const definition = await createDefinition(source, options);
  return runDefinition(definition, options);
}
