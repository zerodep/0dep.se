import { createDefinition, runDefinition, stepDefinition, stopDefinition, switchStepMode, listDmnDecisions } from './bpmn-runner.js';

const LOGGED_EVENTS = /^(definition|process|activity)\.(enter|start|wait|end|leave|error)$|^flow\.take$|^activity\.timer$/;
const DISCARD_EVENTS = new Set(['activity.discard', 'activity.execution.discard']);

const sourceEl = document.querySelector('#source');
const variablesEl = document.querySelector('#variables');
const variablesErrorEl = document.querySelector('#variables-error');
const runBtn = document.querySelector('#run');
const stepBtn = document.querySelector('#step');
const stopBtn = document.querySelector('#stop');
const resumeBtn = document.querySelector('#resume');
const exampleBtn = document.querySelector('#example');
const stepModeEl = document.querySelector('#step-mode');
const bypassEl = document.querySelector('#bypass');
const maxTouchesEl = document.querySelector('#max-touches');
const logEl = document.querySelector('#log');
const logDetails = document.querySelector('#log-details');
const statsDetails = document.querySelector('#stats-details');
const runStateEl = document.querySelector('#run-state');
const statsTotal = document.querySelector('#stats-total');
const statsBody = document.querySelector('#stats-body');
const outputEl = document.querySelector('#output');
const dropzone = document.querySelector('[data-dropzone]');
const canvasEl = document.querySelector('#canvas');
const canvasNote = document.querySelector('#canvas-note');
const dmnDropzone = document.querySelector('[data-dmn-dropzone]');
const dmnListEl = document.querySelector('#dmn-list');
const propertiesEl = document.querySelector('#properties');
const propertiesTitle = document.querySelector('#properties-title');
const propertiesTaken = document.querySelector('#properties-taken');
const propertiesBody = document.querySelector('#properties-body');

const REF_KEYS = new Set(['sourceRef', 'targetRef', 'default', 'attachedToRef', 'processRef', 'calledElement', 'messageRef', 'signalRef', 'errorRef']);

/** @type {{ name: string, source: string, decisions: { id: string, name?: string }[] }[]} */
const dmnFiles = [];
let runningDefinition = null;
/** Recovered definition on its way in when step mode is switched mid-run (see switchStepMode). */
let pendingSwitch = null;
/** The current run — kept after Stop so Resume can carry on; a new Run or diagram replaces it. */
let session = null;
/** Open wait/timer-line controls by element id, so a discard or completion can retire them. */
const openWaits = new Map();
/** Taken counts of the current run, by element id — feeds badges and the properties pane. */
const runCounts = new Map();
let inspectedId = null;
let viewerPromise;

runBtn.addEventListener('click', () => {
  if (runningDefinition) {
    if (runningStepped() && !stepModeEl.checked) switchRunningMode(false);
    return;
  }
  run();
});
resumeBtn.addEventListener('click', resumeRun);
stopBtn.addEventListener('click', () => {
  if (!runningDefinition || pendingSwitch) return;
  stopBtn.disabled = true;
  stopDefinition(runningDefinition);
});
stepModeEl.addEventListener('change', () => {
  if (!runningDefinition || pendingSwitch) return;
  if (runningStepped()) runBtn.disabled = stepModeEl.checked;
  else stepBtn.disabled = !stepModeEl.checked;
});
stepBtn.addEventListener('click', () => {
  if (!runningDefinition) return;
  if (runningStepped()) stepDefinition(runningDefinition);
  else if (stepModeEl.checked) switchRunningMode(true);
});
exampleBtn?.addEventListener('click', async () => {
  abandonRun();
  exampleBtn.disabled = true;
  try {
    const [bpmn, dmn] = await Promise.all(
      ['/run/pricing.bpmn', '/run/discount.dmn'].map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} ${res.status}`);
        return res.text();
      }),
    );
    sourceEl.value = bpmn;
    variablesEl.value = '{ "order": { "total": 250 } }';
    validateVariables();
    await addDmnFile({ name: 'discount.dmn', text: async () => dmn });
    showDiagram(bpmn);
  } catch (err) {
    logLine(`failed to load example — ${err?.message || err}`, { className: 'error' });
  } finally {
    exampleBtn.disabled = false;
  }
});
variablesEl.addEventListener('input', validateVariables);
sourceEl.addEventListener('paste', () => {
  setTimeout(() => showDiagram(sourceEl.value), 0);
});

wireDropzone(dropzone, async ([file]) => {
  abandonRun();
  sourceEl.value = await file.text();
  showDiagram(sourceEl.value);
});

wireDropzone(dmnDropzone, (files) => {
  for (const file of files) addDmnFile(file);
});

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/run/sw.js').catch(() => {});
}

// --- run ---

/** Start a new run from the source, variables and DMN files on the page. */
async function run() {
  logEl.textContent = '';
  outputEl.textContent = '';
  statsTotal.textContent = '';
  statsBody.textContent = '';
  statsDetails.hidden = false;
  setRunState('starting');
  openWaits.clear();
  runCounts.clear();
  session = null;
  runBtn.disabled = true;
  resumeBtn.disabled = true;

  try {
    const variables = parseVariables(variablesEl.value);

    const source = sourceEl.value;
    const options = {
      variables,
      dmn: dmnFiles.map((f) => f.source),
      onWarning(message) {
        logLine(message, { className: 'warn' });
      },
      onDmnLog({ scope, level, message }) {
        logLine(`${scope} ${message}`, { className: level === 'debug' ? 'muted' : level });
      },
      onServiceCall(name) {
        logLine(`service “${name}” not registered — auto-completed with no variables`, { className: 'muted' });
      },
    };
    const definition = await createDefinition(source, { ...options, step: stepModeEl.checked });

    const viewer = await showDiagram(source);
    const mark = diagramMarkers(viewer);
    const bump = counterBadges(viewer);

    const current = { source, options, definition, segments: [] };
    current.onEvent = (entry) => {
      setRunState(current.definition.activityStatus);
      if (entry.event === 'activity.enter') mark(entry.id, 'run-active');
      else if (entry.event === 'activity.end') {
        mark(entry.id, 'run-completed', 'run-active');
        bump(entry.id);
        if (openWaits.has(entry.id)) retireWaits(entry.id, { silent: true });
      } else if (entry.event === 'activity.error') mark(entry.id, 'run-errored', 'run-active');
      else if (entry.event === 'flow.take') bump(entry.id, 'flow');
      else if (DISCARD_EVENTS.has(entry.event)) {
        mark(entry.id, 'run-discarded', 'run-active');
        if (openWaits.has(entry.id)) {
          retireWaits(entry.id);
          logLine(describe(entry), { className: 'muted' });
        }
      }

      if (!LOGGED_EVENTS.test(entry.event)) return;
      if (entry.event === 'activity.timer') {
        logTimer(entry);
        return;
      }
      if (entry.event === 'activity.wait' && entry.api) {
        if (entry.autoSignaled) {
          logLine(`${describe(entry)} — bypassed`, { className: 'muted' });
        } else {
          logWait(entry);
        }
        return;
      }
      logLine(describe(entry), entry.event.endsWith('.error') ? { className: 'error' } : undefined);
    };
    session = current;
  } catch (err) {
    setRunState('errored');
    logLine(String(err && err.message || err), { className: 'error' });
    runBtn.disabled = false;
    return;
  }
  await drive(session, false);
}

/** Resume the stopped run, in the mode the step checkbox asks for. */
async function resumeRun() {
  const current = session;
  if (!current?.stopped || runningDefinition) return;
  current.stopped = false;
  runBtn.disabled = true;
  resumeBtn.disabled = true;
  try {
    if (Boolean(current.definition.environment.settings.step) !== stepModeEl.checked) {
      current.definition = await switchStepMode(current.definition, current.source, stepModeEl.checked, current.options);
    }
  } catch (err) {
    setRunState('errored');
    logLine(`could not resume — ${err?.message || err}`, { className: 'error' });
    session = null;
    runBtn.disabled = false;
    return;
  }
  logLine('resumed', { className: 'muted' });
  await drive(current, true);
}

/** Run the session's definition until it completes, errors or is stopped. */
async function drive(current, resume) {
  let result;
  runBtn.disabled = true;
  resumeBtn.disabled = true;
  try {
    for (;;) {
      const definition = current.definition;
      runningDefinition = definition;
      const stepping = definition.environment.settings.step;
      stepBtn.disabled = !stepping;
      stopBtn.disabled = false;
      stepModeEl.disabled = false;
      if (stepping) logLine('step mode — press Step to advance', { className: 'muted' });

      result = await runDefinition(definition, {
        resume,
        autoSignal: bypassEl.checked,
        maxTouches: Number(maxTouchesEl.value) || 10,
        onEvent: current.onEvent,
      });
      current.segments.push(result.stats);
      // the stopped definition's wait apis are dead — resuming surfaces live ones
      if (result.stopped) for (const id of [...openWaits.keys()]) retireWaits(id, { silent: true });
      if (!result.stopped || !pendingSwitch) break;

      const switching = pendingSwitch;
      stopBtn.disabled = true;
      const next = await switching;
      if (pendingSwitch !== switching) break; // abandoned mid-switch
      pendingSwitch = null;
      current.definition = next;
      resume = true;
      logLine(next.environment.settings.step ? 'switched to step mode' : 'switched to run through', { className: 'muted' });
    }
    if (result.stopped) {
      setRunState('stopped');
      logLine('run stopped', { className: 'muted' });
      if (session === current) current.stopped = true;
      return;
    }
    if (session === current) session = null;
    setRunState('completed');
    outputEl.textContent = `output: ${JSON.stringify(result.output, null, 2)}`;
    renderStats(mergeStats(current.segments));
  } catch (err) {
    if (session === current) session = null;
    setRunState('errored');
    logLine(String(err && err.message || err), { className: 'error' });
  } finally {
    runningDefinition = null;
    pendingSwitch = null;
    runBtn.disabled = false;
    stepBtn.disabled = true;
    stopBtn.disabled = true;
    stepModeEl.disabled = false;
    resumeBtn.disabled = !(session === current && current.stopped);
  }
}

/** Switch the running definition in or out of step mode. */
function switchRunningMode(step) {
  if (!runningDefinition || pendingSwitch || !session) return;
  stepModeEl.disabled = true;
  stepBtn.disabled = true;
  runBtn.disabled = true;
  pendingSwitch = switchStepMode(runningDefinition, session.source, step, session.options);
  pendingSwitch.catch((err) => {
    pendingSwitch = null;
    stepModeEl.disabled = false;
    logLine(`could not switch step mode — ${err?.message || err}`, { className: 'error' });
  });
}

function runningStepped() {
  return Boolean(runningDefinition?.environment.settings.step);
}

/** Stop any running definition and forget the run — nothing left to resume. */
function abandonRun() {
  session = null;
  resumeBtn.disabled = true;
  if (!runningDefinition) return;
  const definition = runningDefinition;
  runningDefinition = null;
  pendingSwitch = null;
  definition.stop();
}

/** Parse the variables textarea — empty means none; anything but a JSON object throws. */
function parseVariables(raw) {
  const json = raw.trim();
  if (!json) return undefined;
  let variables;
  try {
    variables = JSON.parse(json);
  } catch (err) {
    throw new Error(`variables is not valid JSON — ${err.message}`);
  }
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    throw new Error('variables must be a JSON object');
  }
  return variables;
}

/** Flag the variables textarea when it doesn't parse. */
function validateVariables() {
  let message = '';
  try {
    parseVariables(variablesEl.value);
  } catch (err) {
    message = err.message;
  }
  variablesEl.classList.toggle('invalid', Boolean(message));
  if (message) variablesEl.setAttribute('aria-invalid', 'true');
  else variablesEl.removeAttribute('aria-invalid');
  variablesErrorEl.textContent = message;
  variablesErrorEl.hidden = !message;
}

function setRunState(state) {
  runStateEl.textContent = state ? `— ${state}` : '';
}

/** Sum the stats of the run segments on either side of step mode switches and stops. */
function mergeStats(segments) {
  const activities = new Map();
  for (const { activities: list } of segments) {
    for (const a of list) {
      const merged = activities.get(a.id);
      if (merged) {
        merged.runs += a.runs;
        merged.totalMs += a.totalMs;
      } else {
        activities.set(a.id, { ...a });
      }
    }
  }
  return {
    duration: segments.reduce((ms, s) => ms + s.duration, 0),
    activities: [...activities.values()],
  };
}

function renderStats(stats) {
  statsBody.textContent = '';
  const byTime = [...stats.activities].sort((a, b) => b.totalMs - a.totalMs);
  for (const activity of byTime) {
    const tr = document.createElement('tr');
    const cells = [
      activity.name ? `${activity.name} (${activity.id})` : activity.id,
      activity.type,
      String(activity.runs),
      activity.totalMs.toFixed(1),
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    statsBody.append(tr);
  }
  const totalRuns = stats.activities.reduce((n, a) => n + a.runs, 0);
  statsTotal.textContent = `Run took ${stats.duration.toFixed(1)} ms — ${stats.activities.length} activities, ${totalRuns} activity runs`;
}

// --- log ---

/** Log a wait with a JSON payload input and Signal (and Cancel) buttons. */
function logWait(entry) {
  logDetails.open = true;

  const li = document.createElement('li');
  li.className = 'wait';
  li.append(describe(entry));

  if (!acceptsApi(entry, 'signal')) {
    logEl.append(li);
    trackOpenWait(entry.id, { li, btn: { disabled: true } });
    return;
  }

  const payloadInput = document.createElement('input');
  payloadInput.type = 'text';
  payloadInput.className = 'signal-payload';
  payloadInput.placeholder = '{ "approved": true }';
  payloadInput.setAttribute('aria-label', 'Signal payload (JSON)');

  const signalBtn = document.createElement('button');
  signalBtn.type = 'button';
  signalBtn.textContent = 'Signal';

  const signal = () => {
    let payload;
    const raw = payloadInput.value.trim();
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        payloadInput.classList.add('invalid');
        payloadInput.title = `not valid JSON — ${err.message}`;
        return;
      }
    }
    payloadInput.classList.remove('invalid');
    // a conditional event may stay waiting on a false condition
    entry.api.signal(payload);
  };

  signalBtn.addEventListener('click', signal);
  payloadInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') signal();
  });

  li.append(' ', payloadInput, ' ', signalBtn);

  const buttons = [signalBtn];
  if (acceptsApi(entry, 'cancel') && entry.accepts?.includes('cancel')) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      entry.api.cancel();
    }, { once: true });
    li.append(' ', cancelBtn);
    buttons.push(cancelBtn);
  }

  logEl.append(li);
  trackOpenWait(entry.id, { li, input: payloadInput, buttons });
}

/** Log a timer with a Cancel button that completes it right away. */
function logTimer(entry) {
  logDetails.open = true;

  const li = document.createElement('li');
  li.className = 'timer wait';
  li.append(`${describe(entry)} — waiting ${entry.timeout} ms`);

  if (!acceptsApi(entry, 'cancel')) {
    logEl.append(li);
    return;
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  const removeOpenWait = trackOpenWait(entry.id, { li, btn: cancelBtn });
  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    removeOpenWait();
    entry.api.cancel();
  }, { once: true });

  li.append(' ', cancelBtn);
  logEl.append(li);
}

function logLine(text, { className, action } = {}) {
  const li = document.createElement('li');
  if (className) li.className = className;
  li.append(text);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      action.onClick();
    }, { once: true });
    li.append(' ', btn);
  }
  logEl.append(li);
  return li;
}

function describe(entry) {
  const name = entry.name ? ` “${entry.name}”` : '';
  return `${entry.event} — ${entry.id}${name}`;
}

function acceptsApi(entry, apiType) {
  return !entry.accepts || entry.accepts.includes(apiType);
}

function trackOpenWait(id, openWait) {
  let waits = openWaits.get(id);
  if (!waits) openWaits.set(id, (waits = new Set()));
  waits.add(openWait);
  return function removeOpenWait() {
    waits.delete(openWait);
    if (!waits.size) openWaits.delete(id);
  };
}

/** Disable the wait controls of an element that completed or was discarded. */
function retireWaits(id, { silent } = {}) {
  for (const wait of openWaits.get(id) || []) {
    if (wait.input) wait.input.disabled = true;
    if (wait.btn) wait.btn.disabled = true;
    for (const btn of wait.buttons || []) btn.disabled = true;
    if (!silent) {
      wait.li.classList.add('discarded');
      wait.li.append(' — discarded');
    }
  }
  openWaits.delete(id);
}

// --- diagram viewer (bpmn-js), loaded as a separate module chunk on demand ---

async function showDiagram(xml) {
  if (!xml.trim()) return null;
  propertiesEl.hidden = true;
  inspectedId = null;
  try {
    const viewer = await getViewer();
    await viewer.importXML(xml);
    viewer.get('canvas').zoom('fit-viewport');
    canvasNote.hidden = true;
    return viewer;
  } catch (err) {
    canvasNote.hidden = false;
    canvasNote.textContent = `Diagram not rendered: ${err?.message || err}`;
    return null;
  }
}

function getViewer() {
  if (!viewerPromise) {
    viewerPromise = import('bpmn-js/lib/NavigatedViewer.js').then(({ default: NavigatedViewer }) => {
      const viewer = new NavigatedViewer({ container: canvasEl });
      viewer.on('element.click', (e) => {
        const canvas = viewer.get('canvas');
        if (inspectedId && viewer.get('elementRegistry').get(inspectedId)) {
          canvas.removeMarker(inspectedId, 'inspected');
        }
        inspectedId = null;
        if (showProperties(e.element)) {
          inspectedId = e.element.id;
          canvas.addMarker(inspectedId, 'inspected');
        }
      });

      if (typeof ResizeObserver === 'function') {
        let pending = false;
        new ResizeObserver(() => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            try {
              viewer.get('canvas').zoom('fit-viewport');
            } catch {
            }
          });
        }).observe(canvasEl);
      }

      return viewer;
    });
  }
  return viewerPromise;
}

/** Taken counter badges on diagram elements — returns a bump(id, variant) function. */
export function counterBadges(viewer) {
  if (!viewer) return () => {};
  const overlays = viewer.get('overlays');
  const registry = viewer.get('elementRegistry');
  /** @type {Map<string, { el: HTMLElement, count: number }>} */
  const badges = new Map();
  return function bump(id, variant) {
    if (!id || !registry.get(id)) return;
    let badge = badges.get(id);
    if (!badge) {
      const el = document.createElement('span');
      el.className = variant ? `run-counter run-counter-${variant}` : 'run-counter';
      badges.set(id, (badge = { el, count: 0 }));
      overlays.add(id, 'run-counter', { position: { bottom: 10, right: 10 }, html: el });
    }
    badge.count += 1;
    badge.el.textContent = String(badge.count);
    runCounts.set(id, badge.count);
    if (id === inspectedId) renderTakenLine(id);
  };
}

function diagramMarkers(viewer) {
  if (!viewer) return () => {};
  const canvas = viewer.get('canvas');
  const registry = viewer.get('elementRegistry');
  return (id, addClass, removeClass) => {
    if (!id || !registry.get(id)) return;
    if (removeClass) canvas.removeMarker(id, removeClass);
    if (addClass) canvas.addMarker(id, addClass);
  };
}

function showProperties(element) {
  const businessObject = element?.businessObject;
  if (!businessObject || element.type === 'label' || businessObject.$type === 'bpmn:Process' || businessObject.$type === 'bpmn:Collaboration') {
    propertiesEl.hidden = true;
    return false;
  }
  propertiesTitle.textContent = businessObject.name
    ? `${businessObject.name} — ${businessObject.$type} <${businessObject.id}>`
    : `${businessObject.$type} <${businessObject.id}>`;
  renderTakenLine(businessObject.id);
  propertiesBody.textContent = moddleProperties(businessObject);
  propertiesEl.hidden = false;
  return true;
}

/** A moddle business object as readable JSON, references collapsed to ids. */
export function moddleProperties(businessObject) {
  const seen = new WeakSet();
  return JSON.stringify(businessObject, function replacer(key, value) {
    if (key !== '$type' && key !== '$attrs' && key.startsWith('$')) return undefined;
    if (key === 'di') return undefined;
    if (value?.$type) {
      if (REF_KEYS.has(key)) return value.id;
      if (seen.has(value)) return `[circular ${value.id || value.$type}]`;
      seen.add(value);
    }
    if ((key === 'incoming' || key === 'outgoing') && Array.isArray(value)) {
      return value.map((v) => v?.id ?? v);
    }
    return value;
  }, 2);
}

/** Times an element was taken in the current run. */
export function takenCount(id) {
  return runCounts.get(id) || 0;
}

function renderTakenLine(id) {
  const count = takenCount(id);
  propertiesTaken.textContent = count
    ? `taken ${count} time${count === 1 ? '' : 's'} this run`
    : 'not taken this run';
}

// --- files ---

async function addDmnFile(file) {
  const source = await file.text();
  try {
    const decisions = await listDmnDecisions(source);
    const entry = { name: file.name, source, decisions };
    const ids = new Set(decisions.map((d) => d.id));
    const existing = dmnFiles.findIndex(
      (f) => f.name === entry.name || f.decisions.some((d) => ids.has(d.id)),
    );
    if (existing >= 0) dmnFiles[existing] = entry;
    else dmnFiles.push(entry);
    renderDmnList();
  } catch (err) {
    const li = document.createElement('li');
    li.className = 'error';
    li.textContent = `${file.name} — not a valid DMN file (${err?.message || err})`;
    dmnListEl.append(li);
  }
}

function renderDmnList() {
  dmnListEl.textContent = '';
  for (const [index, file] of dmnFiles.entries()) {
    const li = document.createElement('li');
    const decisions = file.decisions
      .map((d) => (d.name ? `${d.name} (${d.id})` : d.id))
      .join(', ');
    li.append(`${file.name} — ${decisions || 'no decisions'}`);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.className = 'secondary';
    remove.addEventListener('click', () => {
      dmnFiles.splice(index, 1);
      renderDmnList();
    }, { once: true });
    li.append(' ', remove);
    dmnListEl.append(li);
  }
}

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
