import { createDefinition, runDefinition, stepDefinition, listDmnDecisions } from './bpmn-runner.js';

const LOGGED_EVENTS = /^(definition|process|activity)\.(enter|start|wait|end|leave|error)$|^flow\.take$|^activity\.timer$/;
// a never-entered element is discarded; a waiting/running one gets its execution discarded
const DISCARD_EVENTS = new Set(['activity.discard', 'activity.execution.discard']);

const sourceEl = document.querySelector('#source');
const variablesEl = document.querySelector('#variables');
const runBtn = document.querySelector('#run');
const stepBtn = document.querySelector('#step');
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

function setRunState(state) {
  runStateEl.textContent = state ? `— ${state}` : '';
}
const outputEl = document.querySelector('#output');
const dropzone = document.querySelector('[data-dropzone]');
const canvasEl = document.querySelector('#canvas');
const canvasNote = document.querySelector('#canvas-note');
const dmnDropzone = document.querySelector('[data-dmn-dropzone]');
const dmnListEl = document.querySelector('#dmn-list');

/** @type {{ name: string, source: string, decisions: { id: string, name?: string }[] }[]} */
const dmnFiles = [];

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

async function addDmnFile(file) {
  const source = await file.text();
  try {
    const decisions = await listDmnDecisions(source);
    const entry = { name: file.name, source, decisions };
    // re-dropping the same file (by name) or a file providing the same
    // decision replaces the existing entry instead of shadowing it
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

let runningDefinition = null;

/** Stop any running definition — its run settles as stopped, which resets the buttons. */
function abandonRun() {
  if (!runningDefinition) return;
  const definition = runningDefinition;
  runningDefinition = null;
  definition.stop();
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

function describe(entry) {
  const name = entry.name ? ` “${entry.name}”` : '';
  return `${entry.event} — ${entry.id}${name}`;
}

/**
 * A wait gets its own log line: an optional JSON payload input and a Signal
 * button. Invalid JSON marks the input and keeps the button armed for a retry.
 * The log auto-expands so the Signal button is never hidden behind the
 * collapsed summary.
 */
/** Open wait/timer-line controls by element id, so a discard or completion can retire them. */
const openWaits = new Map();

function trackOpenWait(id, openWait) {
  let waits = openWaits.get(id);
  if (!waits) openWaits.set(id, (waits = new Set()));
  waits.add(openWait);
  return function removeOpenWait() {
    waits.delete(openWait);
    if (!waits.size) openWaits.delete(id);
  };
}

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

/**
 * A timer gets a log line with a Cancel button — cancelling completes the
 * event immediately instead of waiting out the timeout.
 */
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

// absent accepts (older engine messages) falls back to offering the control
const acceptsApi = (entry, apiType) => !entry.accepts || entry.accepts.includes(apiType);

function logWait(entry) {
  logDetails.open = true;

  const li = document.createElement('li');
  li.className = 'wait';
  li.append(describe(entry));

  if (!acceptsApi(entry, 'signal')) {
    // nothing the user can click for this wait (e.g. an error catch) — plain line
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
    // don't retire here — a conditional event may stay waiting on a false
    // condition; completion or discard retires the line via retireWaits
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

// --- diagram viewer (bpmn-js), loaded as a separate module chunk on demand ---

const propertiesEl = document.querySelector('#properties');
const propertiesTitle = document.querySelector('#properties-title');
const propertiesTaken = document.querySelector('#properties-taken');
const propertiesBody = document.querySelector('#properties-body');

/** Taken counts of the current run, by element id — feeds badges and the properties pane. */
const runCounts = new Map();
let inspectedId = null;

export function takenCount(id) {
  return runCounts.get(id) || 0;
}

function renderTakenLine(id) {
  const count = takenCount(id);
  propertiesTaken.textContent = count
    ? `taken ${count} time${count === 1 ? '' : 's'} this run`
    : 'not taken this run';
}

const REF_KEYS = new Set(['sourceRef', 'targetRef', 'default', 'attachedToRef', 'processRef', 'calledElement', 'messageRef', 'signalRef', 'errorRef']);

/**
 * Render a moddle business object as readable JSON: drop moddle bookkeeping,
 * collapse references and flow lists to ids, guard against cycles.
 */
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

let viewerPromise;
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

      // refit the diagram when the panel is resized (CSS resize handle,
      // window resizes) — coalesced to one refit per frame
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
              // no diagram imported yet — nothing to refit
            }
          });
        }).observe(canvasEl);
      }

      return viewer;
    });
  }
  return viewerPromise;
}

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

/**
 * Overlay a "taken" counter badge on diagram elements: one badge per element,
 * created on first bump and updated in place. Overlays are cleared with the
 * diagram re-import at the start of each run.
 */
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

// --- run ---

async function run() {
  logEl.textContent = '';
  outputEl.textContent = '';
  statsTotal.textContent = '';
  statsBody.textContent = '';
  statsDetails.hidden = false;
  setRunState('starting');
  openWaits.clear();
  runCounts.clear();
  runBtn.disabled = true;

  try {
    let variables;
    const variablesJson = variablesEl.value.trim();
    if (variablesJson) {
      try {
        variables = JSON.parse(variablesJson);
      } catch (err) {
        throw new Error(`variables is not valid JSON — ${err.message}`);
      }
      if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
        throw new Error('variables must be a JSON object');
      }
    }

    const stepping = stepModeEl.checked;
    const definition = await createDefinition(sourceEl.value, {
      step: stepping,
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
    });

    const viewer = await showDiagram(sourceEl.value);
    const mark = diagramMarkers(viewer);
    const bump = counterBadges(viewer);

    runningDefinition = definition;
    stepBtn.disabled = !stepping;
    if (stepping) logLine('step mode — press Step to advance', { className: 'muted' });

    const { output, stats, stopped } = await runDefinition(definition, {
      autoSignal: bypassEl.checked,
      maxTouches: Number(maxTouchesEl.value) || 10,
      onEvent(entry) {
        setRunState(definition.activityStatus);
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
      },
    });
    if (stopped) {
      setRunState('stopped');
      logLine('run stopped', { className: 'muted' });
      return;
    }
    setRunState('completed');
    outputEl.textContent = `output: ${JSON.stringify(output, null, 2)}`;
    renderStats(stats);
  } catch (err) {
    setRunState('errored');
    logLine(String(err && err.message || err), { className: 'error' });
  } finally {
    runningDefinition = null;
    runBtn.disabled = false;
    stepBtn.disabled = true;
  }
}

runBtn.addEventListener('click', run);
stepBtn.addEventListener('click', () => {
  if (runningDefinition) stepDefinition(runningDefinition);
});
// the example resources are copied to /run/ at build time from test/resources
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
    await addDmnFile({ name: 'discount.dmn', text: async () => dmn });
    showDiagram(bpmn);
  } catch (err) {
    logLine(`failed to load example — ${err?.message || err}`, { className: 'error' });
  } finally {
    exampleBtn.disabled = false;
  }
});
sourceEl.addEventListener('paste', () => {
  setTimeout(() => showDiagram(sourceEl.value), 0);
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
  abandonRun();
  sourceEl.value = await file.text();
  showDiagram(sourceEl.value);
});

wireDropzone(dmnDropzone, (files) => {
  for (const file of files) addDmnFile(file);
});

// offline support — the service worker precaches the page and engine bundles
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/run/sw.js').catch(() => {
    /* offline support is progressive enhancement — a failed registration is fine */
  });
}
