import { BpmnModdle } from 'bpmn-moddle';
import * as elements from 'bpmn-elements';
import { parseDmn, listDecisions, forwardingLogger } from './dmn-runner.js';
import { makeTakeHelper } from './take-helper.js';
import { Context as DmnContext, Definition as DmnDefinition, Environment as DmnEnvironment } from 'dmn-elements';
import { Serializer, TypeResolver } from 'moddle-context-serializer';
import { extensions, extendFn, FeelExpressions, FeelScripts, TimerEventDefinition } from '@0dep/bpmn-extensions';
import zeebeSchema from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import camundaSchema from 'camunda-bpmn-moddle/resources/camunda.json' with { type: 'json' };

// cron-capable timer definition
const typeResolver = TypeResolver({ ...elements, TimerEventDefinition });

const CAMUNDA7_NS = 'http://camunda.org/schema/1.0/bpmn';
const ZEEBE_NS = 'http://camunda.org/schema/zeebe/1.0';
const BYPASSABLE_TYPES = new Set(['bpmn:UserTask', 'bpmn:ManualTask']);

/**
 * Parse BPMN 2.0 XML (zeebe or camunda 7) into a runnable bpmn-elements Definition.
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
  const userServices = { takeOnce, takeTwice, delay, ...options.services };
  const services = {
    ...(dmn?.length ? await dmnDecisionServices(dmn, onDmnLog, userServices) : undefined),
    ...userServices,
  };

  const moddleContext = await createModdle(String(source)).fromXML(String(source));
  const serialized = Serializer(moddleContext, typeResolver, extendFn);
  const environment = new elements.Environment({
    // merges signal output of plain elements @0dep/bpmn-extensions skips
    settings: { enableDummyService: true, step: Boolean(step), assignOutput: 'auto' },
    expressions: hybridExpressions(),
    scripts: passThroughScripts(),
    extensions: { flowExtensions: extensions },
    variables: { takeOnce, takeTwice, ...variables },
    services: stubbedServices(services, onServiceCall),
  });
  const context = new elements.Context(serialized, environment);

  if (!context.getExecutableProcesses().length) {
    throw new Error('diagram has no executable process (set isExecutable="true")');
  }

  if (onWarning) warnLiteralConditions(context, onWarning);

  const definition = new elements.Definition(context);

  return definition;
}

/**
 * Run a Definition, forwarding every engine event to onEvent. Resolves
 * `{ output, events, definition, stats }` when it leaves, with `stopped: true`
 * when stopped; rejects on error or a suspected infinite loop.
 * @param {object} definition
 * @param {object} [options]
 * @param {(entry: {event: string, id: string, type: string, name?: string, api?: object, autoSignaled?: boolean}) => void} [options.onEvent]
 * @param {boolean} [options.autoSignal] bypass user and manual tasks
 * @param {number} [options.maxTouches] per-activity touch limit outside step mode, defaults to 10
 * @param {boolean} [options.resume] resume a recovered definition (see switchStepMode) instead of running it
 */
export function runDefinition(definition, options = {}) {
  const { onEvent, autoSignal, maxTouches = 10, resume } = options;
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
        if (accepts) entry.accepts = accepts;
        if (routingKey === 'activity.timer') {
          entry.timeout = message.content.timeout;
          entry.api = definition.getApi(message);
        }

        if (routingKey === 'activity.leave') {
          // in flight when resumed — its enter happened in the stopped run
          const enteredAt = runStarts.get(executionId) ?? (resume ? startedAt : undefined);
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
              // settle first, so the stop event cannot resolve the run as stopped
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
      if (resume) definition.resume();
      else definition.run();
    } catch (err) {
      settle(reject, err);
    }
  });
}

/** Parse, wire and run a BPMN source in one call — takes both createDefinition and runDefinition options. */
export async function runBpmn(source, options = {}) {
  const definition = await createDefinition(source, options);
  return runDefinition(definition, options);
}

/** Advance a step-mode run one step. Returns true if anything advanced. */
export function stepDefinition(definition) {
  let advanced = false;
  for (const bp of definition.getRunningProcesses() || []) {
    if (stepPostponed(bp.getPostponed(), bp)) advanced = true;
  }
  return advanced;
}

/** Stop a run so it can be resumed with runDefinition(..., { resume: true }). */
export function stopDefinition(definition) {
  if (definition.environment.settings.step) settleExecuted(definition);
  definition.stop();
}

/**
 * Stop a running definition and recover it in or out of step mode — pass the
 * result to runDefinition with `resume: true` to carry on.
 * @param {object} definition the running definition
 * @param {string} source the BPMN source the definition was created from
 * @param {boolean} step step mode for the rest of the run
 * @param {object} [options] the createDefinition options the run was created with
 */
export async function switchStepMode(definition, source, step, options = {}) {
  // step is cloned into every process environment, so it can't be flipped in place
  const next = await createDefinition(source, { ...options, step });
  if (definition.environment.settings.step) settleExecuted(definition);
  const state = withStepSetting(definition.getState(), Boolean(step));
  definition.stop();
  return next.recover(state);
}

/** List the decisions and decision services of a DMN source as `{ id, name }`. */
export async function listDmnDecisions(source) {
  return listDecisions(await parseDmn(source)).map(({ id, name }) => ({ id, name }));
}

/** A moddle with the zeebe or camunda 7 schema, whichever the source declares — zeebe by default. */
function createModdle(source) {
  // the schemas clash on `modelerTemplate`, so moddle can't register both
  if (source.includes(CAMUNDA7_NS) && !source.includes(ZEEBE_NS)) {
    return new BpmnModdle({ camunda: camundaSchema });
  }
  return new BpmnModdle({ zeebe: zeebeSchema });
}

/** One service per DMN decision, named by decision id, evaluated with the process variables as input. */
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

/** Warn about flow conditions that are neither FEEL nor a template — they are always taken. */
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

/** Expressions resolved as FEEL (leading `=`) or camunda 7 `${...}` templates, anything else a literal. */
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

/** FEEL scripts, with script tasks in other formats running through instead of failing. */
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
      // conditions and event definitions fall back to expression evaluation
      if (activity.type === 'bpmn:ScriptTask') return passThrough;
      return undefined;
    },
  };
}

/** Services where any unregistered name resolves to a stub that completes with no variables. */
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
 * `delay` service: completes after a 1 ms timeout.
 * @this {import('bpmn-elements').Activity}
 */
function delay(_elementApi, callback) {
  this.environment.timers.register(this).setTimeout(callback, 1, null, {});
}

function stepPostponed(postponed, activityScope) {
  let advanced = false;
  for (const api of postponed) {
    const owner = api.owner;

    // its own execution is among the postponed apis — only descend into inner elements
    if (owner.isSubProcess && typeof api.getPostponed === 'function') {
      const inner = api.getPostponed().filter((sub) => sub.owner !== owner);
      if (stepPostponed(inner, subProcessScope(owner))) advanced = true;
    }

    if (typeof owner.next === 'function') {
      if (owner.next()) advanced = true;
      continue;
    }

    // a looped flow has no next() — nudge the activities on either end
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

/** Step every activity parked at `executed` on to `end` before a stop or state capture. */
function settleExecuted(definition) {
  // bpmn-elements 18.1: resumed at `executed`, the activity stays `executing` for good
  for (const bp of definition.getRunningProcesses() || []) settleExecutedPostponed(bp.getPostponed());
}

function settleExecutedPostponed(postponed) {
  for (const api of postponed) {
    const owner = api.owner;
    if (owner.isSubProcess && typeof api.getPostponed === 'function') {
      settleExecutedPostponed(api.getPostponed().filter((sub) => sub.owner !== owner));
    }
    if (owner.status === 'executed') owner.next?.();
  }
}

/** Set `step` in every environment settings of a captured state. */
function withStepSetting(state, step) {
  if (!state || typeof state !== 'object') return state;
  if (state.settings && 'step' in state.settings) state.settings.step = step;
  for (const value of Object.values(state)) withStepSetting(value, step);
  return state;
}
