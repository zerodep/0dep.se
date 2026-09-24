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
  el.dispatchEvent(new window.Event('click'));
}

before(async () => {
  const { build } = await import('../src/build.js');
  await build();
  const html = await readFile(join(repoRoot, 'dist', 'run', 'index.html'), 'utf8');
  window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  window.document.write(html);
  document = window.document;
  globalThis.document = document;
  // the example loader fetches /run/*.bpmn|dmn — serve them from dist
  globalThis.fetch = async (url) => {
    const content = await readFile(join(repoRoot, 'dist', 'run', basename(String(url))), 'utf8');
    return { ok: true, text: async () => content };
  };
  await import('../src/runner/bpmn-app.js');
});

const USER_TASK_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_ui" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="approval" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-approve" sourceRef="start" targetRef="approve" />
    <userTask id="approve" name="Approve order" />
    <sequenceFlow id="to-end" sourceRef="approve" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

test('counterBadges overlays taken counts on diagram elements', async () => {
  const { counterBadges, takenCount } = await import('../src/runner/bpmn-app.js');

  const added = [];
  const fakeViewer = {
    get(name) {
      if (name === 'overlays') return { add: (id, type, overlay) => added.push({ id, type, overlay }) };
      if (name === 'elementRegistry') return { get: (id) => (id === 'missing' ? undefined : { id }) };
      throw new Error(`unexpected service ${name}`);
    },
  };

  const bump = counterBadges(fakeViewer);
  bump('task');
  bump('task');
  bump('flow1', 'flow');
  bump('missing'); // not in the diagram — ignored

  assert.equal(added.length, 2, 'one overlay per element');
  assert.deepEqual(added.map((a) => a.id).sort(), ['flow1', 'task']);
  const taskBadge = added.find((a) => a.id === 'task');
  assert.equal(taskBadge.overlay.html.textContent, '2', 'badge should show the taken count');
  assert.ok(taskBadge.overlay.html.className.includes('run-counter'));
  assert.ok(!taskBadge.overlay.html.className.includes('run-counter-flow'), 'activity badge should not carry the flow variant');
  const flowBadge = added.find((a) => a.id === 'flow1');
  assert.ok(flowBadge.overlay.html.className.includes('run-counter-flow'), 'flow badge should carry the flow variant');

  assert.equal(counterBadges(null)('task'), undefined, 'no viewer means noop');

  // counts feed the properties pane
  assert.equal(takenCount('task'), 2);
  assert.equal(takenCount('flow1'), 1);
  assert.equal(takenCount('never-ran'), 0);
});

test('Load example loads the pricing resources and runs the decision', async () => {
  click(document.querySelector('#example'));

  await waitFor(() => document.querySelector('#source').value.includes('pricing'));
  assert.match(document.querySelector('#variables').value, /"order"/, 'variables should be prefilled for the input mapping');
  const dmnEntry = await waitFor(() => document.querySelector('#dmn-list li'));
  assert.match(dmnEntry.textContent, /discount/, 'discount.dmn should land in the decisions list');

  click(document.querySelector('#run'));
  await waitFor(() => document.querySelector('#output').textContent);
  assert.match(document.querySelector('#output').textContent, /"rebate": 0.1/);
  assert.equal(document.querySelector('#stats-details').hasAttribute('hidden'), false, 'stats section should appear after the run');
  assert.match(document.querySelector('#run-state').textContent, /completed/i);

  // clean the decisions list for following tests
  const listItems = () => [...document.querySelectorAll('#dmn-list li')];
  while (listItems().length) {
    click(listItems()[0].querySelector('button'));
    await new Promise((r) => setTimeout(r, 10));
  }
});

test('a wait auto-expands the log and Signal accepts a JSON payload', async () => {
  document.querySelector('#log-details').open = false;
  document.querySelector('#source').value = USER_TASK_SOURCE;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  const waitLine = await waitFor(() => document.querySelector('#log li.wait'));
  assert.equal(document.querySelector('#log-details').open, true, 'log should auto-expand on wait');

  const payloadInput = waitLine.querySelector('input.signal-payload');
  assert.ok(payloadInput, 'wait line should have a payload input');
  assert.match(document.querySelector('#run-state').textContent, /wait/i, 'state should show the engine wait status');
  payloadInput.value = '{ "approved": true }';
  click(waitLine.querySelector('button'));

  await waitFor(() => document.querySelector('#output').textContent);
  assert.match(document.querySelector('#output').textContent, /"approved": true/);
});

test('re-dropping a DMN with the same file name or decision id replaces the entry', async () => {
  const dmnSource = (id, name) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Defs_${id}" name="${name}" namespace="https://example.com/dmn/${id}">
  <decision id="${id}" name="${name}">
    <decisionTable id="${id}Table" hitPolicy="UNIQUE">
      <input id="${id}In"><inputExpression id="${id}InExpr" typeRef="number"><text>x</text></inputExpression></input>
      <output id="${id}Out" name="y" typeRef="number" />
      <rule id="${id}Rule"><inputEntry id="${id}Entry"><text>-</text></inputEntry><outputEntry id="${id}OutEntry"><text>1</text></outputEntry></rule>
    </decisionTable>
  </decision>
</definitions>`;

  const drop = (name, source) => {
    const ev = new window.Event('drop', { cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [{ name, text: async () => source }] } });
    document.querySelector('[data-dmn-dropzone]').dispatchEvent(ev);
  };
  const listItems = () => [...document.querySelectorAll('#dmn-list li')];

  drop('fees.dmn', dmnSource('fees', 'Fees'));
  await waitFor(() => listItems().length === 1);

  // same file name again — replaced, not appended
  drop('fees.dmn', dmnSource('fees', 'Fees v2'));
  await waitFor(() => listItems()[0].textContent.includes('Fees v2'));
  assert.equal(listItems().length, 1, 'same file name should replace');

  // different file name but same decision id — replaced too
  drop('fees-final.dmn', dmnSource('fees', 'Fees v3'));
  await waitFor(() => listItems()[0].textContent.includes('fees-final.dmn'));
  assert.equal(listItems().length, 1, 'same decision id should replace');

  // unrelated decision — appended
  drop('rates.dmn', dmnSource('rates', 'Rates'));
  await waitFor(() => listItems().length === 2);

  // clean up for following tests
  while (listItems().length) {
    click(listItems()[0].querySelector('button'));
    await new Promise((r) => setTimeout(r, 10));
  }
});

test('dropping a new bpmn diagram mid-run stops the run and resets the Run button', async () => {
  document.querySelector('#source').value = USER_TASK_SOURCE;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  await waitFor(() => document.querySelector('#log li.wait'));
  assert.equal(document.querySelector('#run').disabled, true, 'run should be disabled while waiting');

  const dropEv = new window.Event('drop', { cancelable: true });
  Object.defineProperty(dropEv, 'dataTransfer', {
    value: { files: [{ name: 'other.bpmn', text: async () => USER_TASK_SOURCE.replace('Def_ui', 'Def_ui2') }] },
  });
  document.querySelector('[data-dropzone]').dispatchEvent(dropEv);

  await waitFor(() => document.querySelector('#run').disabled === false);
  assert.ok(
    [...document.querySelectorAll('#log li')].some((li) => /stopped/i.test(li.textContent)),
    'log should note the abandoned run',
  );
  assert.equal(document.querySelector('#step').disabled, true, 'step should be back to disabled');
  assert.match(document.querySelector('#source').value, /Def_ui2/, 'dropped source should be loaded');
  assert.match(document.querySelector('#run-state').textContent, /stopped/i, 'state should show stopped');
});

test('the loop-guard dropdown sets the touch limit for the run', async () => {
  document.querySelector('#source').value = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_uiloop" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="roundabout" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-a" sourceRef="start" targetRef="a" />
    <task id="a" />
    <sequenceFlow id="to-b" sourceRef="a" targetRef="b" />
    <task id="b" />
    <sequenceFlow id="back-to-a" sourceRef="b" targetRef="a" />
  </process>
</definitions>`;
  document.querySelector('#variables').value = '';
  document.querySelector('#max-touches').value = '20';
  click(document.querySelector('#run'));

  const errorLine = await waitFor(() => document.querySelector('#log li.error'));
  assert.match(errorLine.textContent, /more than 20 times/);

  document.querySelector('#max-touches').value = '10';
});

test('a timer line has a Cancel button that skips the wait', async () => {
  document.querySelector('#source').value = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_uitimer" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="timed" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="pause" />
    <intermediateCatchEvent id="pause">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">PT1H</timeDuration>
      </timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="f2" sourceRef="pause" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  const timerLine = await waitFor(() => document.querySelector('#log li.timer'));
  assert.equal(document.querySelector('#log-details').open, true, 'log should auto-expand on a timer');
  assert.match(timerLine.textContent, /waiting/);

  const cancelBtn = timerLine.querySelector('button');
  assert.ok(cancelBtn, 'timer line should have a Cancel button');
  assert.match(cancelBtn.textContent, /cancel/i);
  click(cancelBtn);

  await waitFor(() => document.querySelector('#output').textContent);
  assert.equal(cancelBtn.disabled, true, 'cancel button should retire after use');
});

test('wait lines only offer Signal when the element accepts it', async () => {
  document.querySelector('#source').value = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_uiaccepts" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="approve" />
    <userTask id="approve" />
    <boundaryEvent id="onerr" attachedToRef="approve"><errorEventDefinition /></boundaryEvent>
    <sequenceFlow id="f2" sourceRef="approve" targetRef="end" />
    <endEvent id="end" />
    <sequenceFlow id="f3" sourceRef="onerr" targetRef="failed" />
    <endEvent id="failed" />
  </process>
</definitions>`;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  await waitFor(() => document.querySelectorAll('#log li.wait').length === 2);
  const lines = [...document.querySelectorAll('#log li.wait')];
  const approveLine = lines.find((li) => li.textContent.includes('approve'));
  const errorLine = lines.find((li) => li.textContent.includes('onerr'));

  assert.ok(approveLine.querySelector('button'), 'signal-accepting wait should have a button');
  assert.equal(errorLine.querySelector('button'), null, 'error-only wait should have no button');
  assert.equal(errorLine.querySelector('input'), null, 'error-only wait should have no payload input');

  click(approveLine.querySelector('button'));
  await waitFor(() => document.querySelector('#output').textContent);
});

test('a conditional event wait line offers both Signal and Cancel', async () => {
  document.querySelector('#source').value = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_uicond" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="cond" />
    <intermediateCatchEvent id="cond">
      <conditionalEventDefinition>
        <condition xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">= ready = true</condition>
      </conditionalEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="f2" sourceRef="cond" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;
  document.querySelector('#variables').value = '{ "ready": false }';
  click(document.querySelector('#run'));

  const waitLine = await waitFor(() => document.querySelector('#log li.wait'));
  const buttons = [...waitLine.querySelectorAll('button')].map((b) => b.textContent);
  assert.deepEqual(buttons, ['Signal', 'Cancel'], `expected Signal and Cancel, got ${buttons}`);

  // signalling with a false condition keeps it waiting; cancel completes
  click([...waitLine.querySelectorAll('button')].find((b) => b.textContent === 'Signal'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(document.querySelector('#output').textContent, '', 'false condition should keep waiting');

  click([...waitLine.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));
  await waitFor(() => document.querySelector('#output').textContent);
  assert.match(document.querySelector('#run-state').textContent, /completed/i);
});

test('a discarded waiting activity gets its Signal disabled and the line marked', async () => {
  document.querySelector('#source').value = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_bound" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="escalate" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="approve" />
    <userTask id="approve" />
    <boundaryEvent id="timeout" attachedToRef="approve">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">PT0.08S</timeDuration>
      </timerEventDefinition>
    </boundaryEvent>
    <sequenceFlow id="f2" sourceRef="approve" targetRef="end" />
    <sequenceFlow id="f3" sourceRef="timeout" targetRef="escalated" />
    <endEvent id="end" />
    <endEvent id="escalated" />
  </process>
</definitions>`;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  const waitLine = await waitFor(() =>
    [...document.querySelectorAll('#log li.wait')].find((li) => li.querySelector('input.signal-payload')),
  );
  const signalBtn = waitLine.querySelector('button');
  assert.equal(signalBtn.disabled, false, 'signal should be armed while waiting');

  await waitFor(() => document.querySelector('#output').textContent);
  assert.equal(signalBtn.disabled, true, 'signal should be disabled after discard');
  assert.ok(waitLine.classList.contains('discarded'), 'wait line should be marked discarded');
  assert.match(waitLine.textContent, /discarded/i);
});

test('an invalid Signal payload does not signal and is marked invalid', async () => {
  document.querySelector('#source').value = USER_TASK_SOURCE;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  const waitLine = await waitFor(() => document.querySelector('#log li.wait'));
  const payloadInput = waitLine.querySelector('input.signal-payload');
  const signalBtn = waitLine.querySelector('button');

  payloadInput.value = '{ nope }';
  click(signalBtn);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(document.querySelector('#output').textContent, '', 'run should not have continued');
  assert.ok(payloadInput.classList.contains('invalid'), 'payload input should be marked invalid');
  assert.equal(signalBtn.disabled, false, 'signal button should stay enabled to retry');

  payloadInput.value = '{ "approved": false }';
  click(signalBtn);
  await waitFor(() => document.querySelector('#output').textContent);
  assert.match(document.querySelector('#output').textContent, /"approved": false/);
});

function change(el, checked) {
  el.checked = checked;
  el.dispatchEvent(new window.Event('change'));
}

const TASKS_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_uitasks" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="chores" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="first" />
    <task id="first" />
    <sequenceFlow id="f2" sourceRef="first" targetRef="second" />
    <task id="second" />
    <sequenceFlow id="f3" sourceRef="second" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

test('unticking step mode mid-run offers Run, which goes the rest of the way through', async () => {
  const stepMode = document.querySelector('#step-mode');
  document.querySelector('#source').value = TASKS_SOURCE;
  document.querySelector('#variables').value = '';
  change(stepMode, true);
  click(document.querySelector('#run'));

  const stepBtn = document.querySelector('#step');
  await waitFor(() => !stepBtn.disabled);
  for (let i = 0; i < 6; i++) {
    click(stepBtn);
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(document.querySelector('#output').textContent, '', 'the stepped run should not have finished yet');

  const runBtn = document.querySelector('#run');
  assert.equal(runBtn.disabled, true, 'run should be disabled while stepping');
  change(stepMode, false);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runBtn.disabled, false, 'unticking step mode should offer Run to go through');
  assert.equal(stepBtn.disabled, false, 'step should keep working until Run is clicked');
  assert.equal(document.querySelector('#output').textContent, '', 'unticking alone should not switch');

  change(stepMode, true);
  assert.equal(runBtn.disabled, true, 'ticking step mode again should withdraw Run');
  change(stepMode, false);
  click(stepBtn);
  await new Promise((r) => setTimeout(r, 1));

  click(runBtn);
  await waitFor(() => document.querySelector('#output').textContent);

  const log = [...document.querySelectorAll('#log li')].map((li) => li.textContent);
  assert.ok(log.some((line) => /switched to run through/i.test(line)), 'log should note the switch');
  assert.ok(!log.some((line) => /run stopped/i.test(line)), 'the switch is not a stopped run');
  assert.match(document.querySelector('#run-state').textContent, /completed/i);
  assert.equal(stepBtn.disabled, true, 'step should be disabled once the run goes through');
  const statsIds = [...document.querySelectorAll('#stats-body tr')].map((tr) => tr.firstChild.textContent);
  for (const id of ['start', 'first', 'second', 'end']) {
    assert.ok(statsIds.includes(id), `stats should cover ${id} from both sides of the switch`);
  }
});

test('ticking step mode mid-run offers Step, which pauses it with fresh Signal controls', async () => {
  const stepMode = document.querySelector('#step-mode');
  change(stepMode, false);
  document.querySelector('#source').value = USER_TASK_SOURCE;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  const firstWait = await waitFor(() => document.querySelector('#log li.wait'));
  const stepBtn = document.querySelector('#step');
  assert.equal(stepBtn.disabled, true);
  change(stepMode, true);
  assert.equal(stepBtn.disabled, false, 'ticking step mode should offer Step');
  assert.equal(document.querySelectorAll('#log li.wait').length, 1, 'ticking alone should not switch');

  click(stepBtn);
  const waits = await waitFor(() => {
    const lines = document.querySelectorAll('#log li.wait');
    return lines.length === 2 && lines;
  });
  assert.equal(firstWait.querySelector('button').disabled, true, 'the pre-switch Signal should retire');
  assert.ok([...document.querySelectorAll('#log li')].some((li) => /switched to step mode/i.test(li.textContent)));

  const freshWait = waits[1];
  freshWait.querySelector('input').value = '{ "approved": true }';
  click(freshWait.querySelector('button'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(document.querySelector('#output').textContent, '', 'the run should now wait for Step');

  for (let i = 0; i < 20 && !document.querySelector('#output').textContent; i++) {
    click(stepBtn);
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.match(document.querySelector('#output').textContent, /"approved": true/);
  change(stepMode, false);
});

test('Stop halts the run and Resume carries on where it stopped', async () => {
  const stopBtn = document.querySelector('#stop');
  const resumeBtn = document.querySelector('#resume');
  assert.equal(stopBtn.disabled, true, 'stop should be disabled without a run');
  assert.equal(resumeBtn.disabled, true, 'resume should be disabled without a stopped run');

  change(document.querySelector('#step-mode'), false);
  document.querySelector('#source').value = USER_TASK_SOURCE;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  const firstWait = await waitFor(() => document.querySelector('#log li.wait'));
  assert.equal(stopBtn.disabled, false, 'stop should be enabled while running');
  assert.equal(resumeBtn.disabled, true, 'resume should stay disabled while running');

  click(stopBtn);
  await waitFor(() => !resumeBtn.disabled);
  assert.match(document.querySelector('#run-state').textContent, /stopped/i);
  assert.ok([...document.querySelectorAll('#log li')].some((li) => /run stopped/i.test(li.textContent)));
  assert.equal(stopBtn.disabled, true, 'stop should be disabled once stopped');
  assert.equal(document.querySelector('#run').disabled, false, 'run should be available to start over');
  assert.equal(firstWait.querySelector('button').disabled, true, 'the stopped wait should retire');

  const linesBefore = document.querySelectorAll('#log li').length;
  click(resumeBtn);
  const freshWait = await waitFor(() => {
    const lines = document.querySelectorAll('#log li.wait');
    return lines.length === 2 && lines[1];
  });
  assert.ok(document.querySelectorAll('#log li').length > linesBefore, 'resume should keep the log and append to it');
  assert.equal(resumeBtn.disabled, true, 'resume should disable while running');
  assert.equal(stopBtn.disabled, false);
  assert.equal(document.querySelector('#run').disabled, true);

  freshWait.querySelector('input').value = '{ "approved": true }';
  click(freshWait.querySelector('button'));
  await waitFor(() => document.querySelector('#output').textContent);
  assert.match(document.querySelector('#output').textContent, /"approved": true/);
  assert.equal(resumeBtn.disabled, true, 'a completed run cannot be resumed');
  assert.equal(stopBtn.disabled, true);
});

test('a stopped step-mode run resumes in step mode', async () => {
  const stepMode = document.querySelector('#step-mode');
  change(stepMode, true);
  document.querySelector('#source').value = TASKS_SOURCE;
  document.querySelector('#variables').value = '';
  click(document.querySelector('#run'));

  const stepBtn = document.querySelector('#step');
  await waitFor(() => !stepBtn.disabled);
  click(stepBtn);
  click(stepBtn);
  click(document.querySelector('#stop'));
  await waitFor(() => !document.querySelector('#resume').disabled);
  assert.equal(stepBtn.disabled, true, 'step should be disabled while stopped');

  click(document.querySelector('#resume'));
  await waitFor(() => !stepBtn.disabled);
  for (let i = 0; i < 30 && !document.querySelector('#output').textContent; i++) {
    click(stepBtn);
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.match(document.querySelector('#run-state').textContent, /completed/i);
  change(stepMode, false);
});

test('dropping a new diagram forgets the stopped run', async () => {
  document.querySelector('#source').value = USER_TASK_SOURCE;
  click(document.querySelector('#run'));
  await waitFor(() => document.querySelector('#log li.wait'));
  click(document.querySelector('#stop'));
  await waitFor(() => !document.querySelector('#resume').disabled);

  const dropEv = new window.Event('drop', { cancelable: true });
  Object.defineProperty(dropEv, 'dataTransfer', {
    value: { files: [{ name: 'other.bpmn', text: async () => TASKS_SOURCE }] },
  });
  document.querySelector('[data-dropzone]').dispatchEvent(dropEv);
  await waitFor(() => document.querySelector('#source').value.includes('Def_uitasks'));
  assert.equal(document.querySelector('#resume').disabled, true, 'a new diagram cannot resume the old run');
});

test('variables are validated as they are typed', async () => {
  const variables = document.querySelector('#variables');
  const error = document.querySelector('#variables-error');
  const type = (value) => {
    variables.value = value;
    variables.dispatchEvent(new window.Event('input'));
  };

  type('{ "order": ');
  assert.equal(variables.classList.contains('invalid'), true, 'invalid JSON should mark the textarea');
  assert.equal(variables.getAttribute('aria-invalid'), 'true');
  assert.equal(error.hidden, false, 'the parse error should be shown beside the textarea');
  assert.match(error.textContent, /not valid JSON/);

  type('[1, 2]');
  assert.match(error.textContent, /must be a JSON object/, 'a non-object should be flagged too');

  type('{ "order": { "total": 1 } }');
  assert.equal(variables.classList.contains('invalid'), false, 'valid JSON should clear the mark');
  assert.equal(variables.hasAttribute('aria-invalid'), false);
  assert.equal(error.hidden, true);

  type('');
  assert.equal(variables.classList.contains('invalid'), false, 'empty variables are fine');
});

test('Run recovers once invalid variables are fixed', async () => {
  const variables = document.querySelector('#variables');
  document.querySelector('#source').value = TASKS_SOURCE;
  variables.value = '{ bad';
  variables.dispatchEvent(new window.Event('input'));
  click(document.querySelector('#run'));
  await waitFor(() => document.querySelector('#log li.error'));
  assert.equal(document.querySelector('#run').disabled, false, 'Run should stay armed for a retry');

  variables.value = '{ "fixed": true }';
  variables.dispatchEvent(new window.Event('input'));
  click(document.querySelector('#run'));
  await waitFor(() => document.querySelector('#output').textContent);
  assert.match(document.querySelector('#run-state').textContent, /completed/i);
});
