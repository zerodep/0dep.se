import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const resources = join(dirname(fileURLToPath(import.meta.url)), 'resources');

import { runBpmn, createDefinition, runDefinition, stepDefinition, listDmnDecisions } from '../src/runner/bpmn-runner.js';

const SIMPLE_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="main" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-task" sourceRef="start" targetRef="task" />
    <task id="task" name="Do the thing" />
    <sequenceFlow id="to-end" sourceRef="task" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

const ZEEBE_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_2" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="orders" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-charge" sourceRef="start" targetRef="charge" />
    <serviceTask id="charge">
      <extensionElements>
        <zeebe:taskDefinition type="charge-card" />
        <zeebe:ioMapping>
          <zeebe:input source="= order.total" target="amount" />
          <zeebe:output source="= transactionId" target="receipt.id" />
        </zeebe:ioMapping>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="to-end" sourceRef="charge" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

const USER_TASK_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_3" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="approval" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-approve" sourceRef="start" targetRef="approve" />
    <userTask id="approve" name="Approve?" />
    <sequenceFlow id="to-end" sourceRef="approve" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

test('runs a plain diagram to completion and reports activity events', async () => {
  const events = [];
  const { output } = await runBpmn(SIMPLE_SOURCE, {
    onEvent: (e) => events.push(e),
  });

  assert.deepEqual(output, {});

  const taskEvents = events.filter((e) => e.id === 'task').map((e) => e.event);
  assert.ok(taskEvents.includes('activity.start'), `task should start, got: ${taskEvents}`);
  assert.ok(taskEvents.includes('activity.end'), `task should end, got: ${taskEvents}`);
  assert.equal(events.at(-1).event, 'definition.leave', 'last event should be definition.leave');
});

test('zeebe extensions: FEEL io-mapping and service dispatch by task definition type', async () => {
  const { output } = await runBpmn(ZEEBE_SOURCE, {
    variables: { order: { total: 199 } },
    services: {
      'charge-card'(elementApi, callback) {
        assert.equal(elementApi.content.input.amount, 199, 'FEEL input mapping should resolve');
        callback(null, { transactionId: 'tx-1' });
      },
    },
  });

  assert.deepEqual(output, { receipt: { id: 'tx-1' } });
});

test('unregistered service types are auto-completed by a stub so pasted diagrams run', async () => {
  const calls = [];
  const { output } = await runBpmn(ZEEBE_SOURCE, {
    variables: { order: { total: 42 } },
    onServiceCall: (name) => calls.push(name),
  });

  assert.deepEqual(calls, ['charge-card']);
  // stub returns no variables, so the output mapping resolves to null
  assert.deepEqual(output, { receipt: { id: null } });
});

test('waiting activities surface a wait event with a signalable api', async () => {
  const waited = [];
  const { output } = await runBpmn(USER_TASK_SOURCE, {
    onEvent(e) {
      if (e.event === 'activity.wait') {
        waited.push(e.id);
        e.api.signal({ approved: true });
      }
    },
  });

  assert.deepEqual(waited, ['approve']);
  assert.equal(output.approved, true);
});

test('a non-object signal payload is surfaced keyed by the activity id (assignOutput auto)', async () => {
  const { output } = await runBpmn(USER_TASK_SOURCE, {
    onEvent(e) {
      if (e.event === 'activity.wait') e.api.signal('yes');
    },
  });

  assert.equal(output.approve, 'yes');
});

const CAMUNDA7_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="Def_c7" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="legacy" isExecutable="true" camunda:historyTimeToLive="30">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="delegate" />
    <serviceTask id="delegate" name="Java delegate" camunda:class="com.acme.ChargeCard" />
    <sequenceFlow id="f2" sourceRef="delegate" targetRef="external" />
    <serviceTask id="external" name="External worker" camunda:type="external" camunda:topic="payments" />
    <sequenceFlow id="f3" sourceRef="external" targetRef="script" />
    <scriptTask id="script" name="Groovy script" scriptFormat="groovy">
      <script>println "hello"</script>
    </scriptTask>
    <sequenceFlow id="f4" sourceRef="script" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

const MANUAL_TASK_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_4" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="handover" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-check" sourceRef="start" targetRef="check" />
    <manualTask id="check" name="Check the shelf" />
    <sequenceFlow id="to-end" sourceRef="check" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

const FEEL_SCRIPT_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_5" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="calc" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-sum" sourceRef="start" targetRef="sum" />
    <scriptTask id="sum">
      <extensionElements>
        <zeebe:script expression="= 1 + 1" resultVariable="sum" />
        <zeebe:ioMapping>
          <zeebe:output source="= sum" target="total" />
        </zeebe:ioMapping>
      </extensionElements>
    </scriptTask>
    <sequenceFlow id="to-end" sourceRef="sum" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

test('camunda 7 diagrams: service and script tasks run through', async () => {
  const { events } = await runBpmn(CAMUNDA7_SOURCE);

  const ended = events.filter((e) => e.event === 'activity.end').map((e) => e.id);
  for (const id of ['delegate', 'external', 'script']) {
    assert.ok(ended.includes(id), `${id} should run through, ended: ${ended}`);
  }
  assert.equal(events.at(-1).event, 'definition.leave');
});

test('zeebe FEEL script tasks still evaluate through the pass-through registry', async () => {
  const { output } = await runBpmn(FEEL_SCRIPT_SOURCE);
  assert.deepEqual(output, { total: 2 });
});

test('wait and timer entries carry what api messages the element accepts', async () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_accepts" targetNamespace="http://bpmn.io/schema/bpmn">
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

  const waits = {};
  await runBpmn(source, {
    onEvent(e) {
      if (e.event === 'activity.wait') {
        waits[e.id] = e.accepts;
        if (e.id === 'approve') setTimeout(() => e.api.signal(), 5);
      }
    },
  });

  assert.ok(waits.approve?.includes('signal'), `user task wait should accept signal, got ${waits.approve}`);
  assert.ok(waits.onerr && !waits.onerr.includes('signal'), `error boundary wait should not accept signal, got ${waits.onerr}`);

  const timed = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_taccepts" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="pause" />
    <intermediateCatchEvent id="pause">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">PT0.02S</timeDuration>
      </timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="f2" sourceRef="pause" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;
  const { events } = await runBpmn(timed);
  const timer = events.find((e) => e.event === 'activity.timer');
  assert.ok(timer.accepts?.includes('cancel'), `timer should accept cancel, got ${timer.accepts}`);
});

test('a stuck conditional event can be cancelled — needs bpmn-elements >= 18.0.20', async () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_cond" targetNamespace="http://bpmn.io/schema/bpmn">
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

  let accepts;
  const { events } = await runBpmn(source, {
    variables: { ready: false },
    onEvent(e) {
      if (e.event === 'activity.wait' && e.id === 'cond') {
        accepts = e.accepts;
        setTimeout(() => e.api.cancel(), 5);
      }
    },
  });

  assert.ok(accepts?.includes('cancel'), `conditional wait should accept cancel, got ${accepts}`);
  assert.ok(
    events.some((e) => e.event === 'activity.end' && e.id === 'cond'),
    'cancelled conditional event should complete, not discard',
  );
  assert.equal(events.at(-1).event, 'definition.leave');
});

test('manual tasks wait for a signal, like user tasks', async () => {
  const waited = [];
  await runBpmn(MANUAL_TASK_SOURCE, {
    onEvent(e) {
      if (e.event === 'activity.wait') {
        waited.push(e.type);
        e.api.signal();
      }
    },
  });
  assert.deepEqual(waited, ['bpmn:ManualTask']);
});

test('autoSignal option bypasses manual and user tasks', async () => {
  const bypassed = [];
  const { output } = await runBpmn(USER_TASK_SOURCE, {
    autoSignal: true,
    onEvent(e) {
      if (e.event === 'activity.wait') bypassed.push({ id: e.id, autoSignaled: e.autoSignaled });
    },
  });
  assert.deepEqual(bypassed, [{ id: 'approve', autoSignaled: true }]);
  assert.deepEqual(output, {});

  const manual = await runBpmn(MANUAL_TASK_SOURCE, { autoSignal: true });
  assert.equal(manual.events.at(-1).event, 'definition.leave');
});

test('autoSignal leaves other waiting activities alone', async () => {
  const receive = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_6" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="inbox" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-receive" sourceRef="start" targetRef="receive" />
    <receiveTask id="receive" />
    <sequenceFlow id="to-end" sourceRef="receive" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

  const waited = [];
  await runBpmn(receive, {
    autoSignal: true,
    onEvent(e) {
      if (e.event === 'activity.wait') {
        waited.push(e.autoSignaled);
        e.api.signal();
      }
    },
  });
  assert.deepEqual(waited, [undefined], 'receive task should not be auto-signaled');
});

test('step mode pauses the run until stepped to completion', async () => {
  const definition = await createDefinition(SIMPLE_SOURCE, { step: true });

  let finished = false;
  const done = runDefinition(definition).then((result) => {
    finished = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(finished, false, 'run should pause immediately in step mode');

  let guard = 200;
  while (!finished && guard--) {
    const advanced = stepDefinition(definition);
    await Promise.resolve();
    if (!advanced && !finished) break;
  }

  const { events } = await done;
  assert.equal(finished, true, 'stepping should complete the run');
  assert.equal(events.at(-1).event, 'definition.leave');
});

test('step mode still surfaces waits, signal resumes stepping', async () => {
  const definition = await createDefinition(USER_TASK_SOURCE, { step: true });

  let waitApi;
  let finished = false;
  const done = runDefinition(definition, {
    onEvent(e) {
      if (e.event === 'activity.wait') waitApi = e.api;
    },
  }).then((result) => {
    finished = true;
    return result;
  });

  let guard = 200;
  while (!waitApi && guard--) {
    stepDefinition(definition);
    await Promise.resolve();
  }
  assert.ok(waitApi, 'stepping should reach the user task wait');

  waitApi.signal({ approved: true });
  guard = 200;
  while (!finished && guard--) {
    stepDefinition(definition);
    await Promise.resolve();
  }

  const { output } = await done;
  assert.equal(output.approved, true);
});

const CIRCULAR_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_loop" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="roundabout" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-a" sourceRef="start" targetRef="a" />
    <task id="a" />
    <sequenceFlow id="to-b" sourceRef="a" targetRef="b" />
    <task id="b" />
    <sequenceFlow id="back-to-a" sourceRef="b" targetRef="a" />
  </process>
</definitions>`;

test('stops circular runs when an activity is touched more than 10 times', async () => {
  await assert.rejects(runBpmn(CIRCULAR_SOURCE), (err) => {
    assert.match(err.message, /loop/i);
    assert.match(err.message, /<a>|<b>/, 'error should name the looping activity');
    return true;
  });
});

test('step mode advances into sub-processes', async () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_sub" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="outer" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-sub" sourceRef="start" targetRef="sub" />
    <subProcess id="sub">
      <startEvent id="inner-start" />
      <sequenceFlow id="to-inner-task" sourceRef="inner-start" targetRef="inner-task" />
      <task id="inner-task" />
      <sequenceFlow id="to-inner-end" sourceRef="inner-task" targetRef="inner-end" />
      <endEvent id="inner-end" />
    </subProcess>
    <sequenceFlow id="to-end" sourceRef="sub" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

  const definition = await createDefinition(source, { step: true });

  let finished = false;
  const done = runDefinition(definition).then((result) => {
    finished = true;
    return result;
  });

  await Promise.resolve();
  let guard = 300;
  while (!finished && guard--) {
    stepDefinition(definition);
    await Promise.resolve();
  }

  const { events } = await done;
  assert.equal(finished, true, 'stepping should complete a run with a sub-process');
  assert.ok(
    events.some((e) => e.event === 'activity.end' && e.id === 'inner-task'),
    'inner task should have been stepped to completion',
  );
  assert.equal(events.at(-1).event, 'definition.leave');
});

test('step mode completes a loop inside a sub-process', async () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_subloop" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="outer" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-sub" sourceRef="start" targetRef="sub" />
    <subProcess id="sub">
      <startEvent id="inner-start" />
      <sequenceFlow id="to-inner-task" sourceRef="inner-start" targetRef="inner-task" />
      <task id="inner-task" />
      <sequenceFlow id="to-inner-gw" sourceRef="inner-task" targetRef="inner-gw" />
      <exclusiveGateway id="inner-gw" default="to-inner-end" />
      <sequenceFlow id="inner-back" sourceRef="inner-gw" targetRef="inner-task">
        <conditionExpression xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">= takeOnce()</conditionExpression>
      </sequenceFlow>
      <sequenceFlow id="to-inner-end" sourceRef="inner-gw" targetRef="inner-end" />
      <endEvent id="inner-end" />
    </subProcess>
    <sequenceFlow id="to-end" sourceRef="sub" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

  const definition = await createDefinition(source, { step: true });

  let finished = false;
  const done = runDefinition(definition).then((result) => {
    finished = true;
    return result;
  });

  await Promise.resolve();
  let guard = 500;
  while (!finished && guard--) {
    stepDefinition(definition);
    await Promise.resolve();
  }

  const { events } = await done;
  assert.equal(finished, true, 'stepping should complete an inner loop');
  assert.equal(
    events.filter((e) => e.event === 'activity.enter' && e.id === 'inner-task').length,
    2,
    'inner task should have looped once',
  );
  assert.equal(events.at(-1).event, 'definition.leave');
});

test('step mode completes a transaction with an armed compensation boundary', async () => {
  // the compensation boundary is discarded when the transaction completes
  // normally — its trailing run messages are invisible to getPostponed
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_transcomp" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="trans" />
    <transaction id="trans">
      <startEvent id="ts" />
      <sequenceFlow id="tf1" sourceRef="ts" targetRef="work" />
      <task id="work" />
      <boundaryEvent id="on-comp" attachedToRef="work"><compensateEventDefinition /></boundaryEvent>
      <task id="undo" isForCompensation="true" />
      <association id="a1" associationDirection="One" sourceRef="on-comp" targetRef="undo" />
      <sequenceFlow id="tf2" sourceRef="work" targetRef="tend" />
      <endEvent id="tend" />
    </transaction>
    <sequenceFlow id="f2" sourceRef="trans" targetRef="booked" />
    <endEvent id="booked" />
  </process>
</definitions>`;

  const definition = await createDefinition(source, { step: true });

  let finished = false;
  const done = runDefinition(definition).then((result) => {
    finished = true;
    return result;
  });

  await Promise.resolve();
  let guard = 400;
  while (!finished && guard--) {
    stepDefinition(definition);
    await Promise.resolve();
  }

  const completed = finished;
  if (!completed) definition.stop(); // do not hang the suite on the upstream stall
  const { events } = await done;
  assert.equal(completed, true, 'stepping should complete past the discarded compensation boundary');
  assert.ok(events.some((e) => e.event === 'activity.end' && e.id === 'booked'));
});

test('step mode runs a transaction to the end event after a cancel run', async () => {
  // cancel on the first pass, retry via the boundary, complete to booked
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_trans" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="booking" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="trans" />
    <transaction id="trans">
      <startEvent id="ts" />
      <sequenceFlow id="tf1" sourceRef="ts" targetRef="book" />
      <task id="book" />
      <sequenceFlow id="tf2" sourceRef="book" targetRef="tgw" />
      <exclusiveGateway id="tgw" default="tf4" />
      <sequenceFlow id="tf3" sourceRef="tgw" targetRef="tcancel">
        <conditionExpression xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">= takeOnce()</conditionExpression>
      </sequenceFlow>
      <sequenceFlow id="tf4" sourceRef="tgw" targetRef="tend" />
      <endEvent id="tcancel"><cancelEventDefinition /></endEvent>
      <endEvent id="tend" />
    </transaction>
    <boundaryEvent id="cancelled" attachedToRef="trans"><cancelEventDefinition /></boundaryEvent>
    <sequenceFlow id="f2" sourceRef="trans" targetRef="booked" />
    <endEvent id="booked" />
    <sequenceFlow id="f3" sourceRef="cancelled" targetRef="handle" />
    <task id="handle" />
    <sequenceFlow id="f4" sourceRef="handle" targetRef="trans" />
  </process>
</definitions>`;

  const definition = await createDefinition(source, { step: true });

  let finished = false;
  const done = runDefinition(definition).then((result) => {
    finished = true;
    return result;
  });

  await Promise.resolve();
  let guard = 800;
  while (!finished && guard--) {
    stepDefinition(definition);
    await Promise.resolve();
  }

  const { events } = await done;
  assert.equal(finished, true, 'stepping should complete the transaction retry');
  assert.ok(
    events.some((e) => e.event === 'activity.end' && e.id === 'cancelled'),
    'cancel boundary should have fired on the first pass',
  );
  assert.ok(
    events.some((e) => e.event === 'activity.end' && e.id === 'booked'),
    'second pass should reach the booked end event',
  );
});

test('step mode is exempt from the touch limit', async () => {
  const definition = await createDefinition(CIRCULAR_SOURCE, { step: true });

  let rejected;
  let enters = 0;
  const done = runDefinition(definition, {
    onEvent(e) {
      if (e.event === 'activity.enter' && e.id === 'a') enters++;
    },
  });
  done.catch((err) => {
    rejected = err;
  });

  let guard = 2000;
  while (enters < 12 && guard--) {
    stepDefinition(definition);
    await Promise.resolve();
  }

  assert.ok(enters >= 12, `expected to step past the limit, got ${enters} enters`);
  assert.equal(rejected, undefined, `stepped circular run should not reject, got: ${rejected}`);
  definition.stop();
});

test('bounded loops under the touch limit still complete', async () => {
  // start → a → b → gateway: loops back to a until count >= 3, then ends
  const bounded = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_bounded" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="retry" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-count" sourceRef="start" targetRef="count" />
    <scriptTask id="count">
      <extensionElements>
        <zeebe:script expression="= count + 1" resultVariable="count" />
      </extensionElements>
    </scriptTask>
    <sequenceFlow id="to-gw" sourceRef="count" targetRef="gw" />
    <exclusiveGateway id="gw" default="back" />
    <sequenceFlow id="back" sourceRef="gw" targetRef="count" />
    <sequenceFlow id="to-end" sourceRef="gw" targetRef="end">
      <conditionExpression xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">= count >= 3</conditionExpression>
    </sequenceFlow>
    <endEvent id="end" />
  </process>
</definitions>`;

  const { events } = await runBpmn(bounded, { variables: { count: 0 } });
  assert.equal(events.at(-1).event, 'definition.leave');
  assert.equal(events.filter((e) => e.event === 'activity.enter' && e.id === 'count').length, 3);
});

const DMN_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="discountDefinitions" name="Discounts" namespace="https://example.com/dmn/discount">
  <decision id="discount" name="Discount">
    <variable id="discountVariable" name="discount" typeRef="number" />
    <decisionTable id="discountTable" hitPolicy="UNIQUE">
      <input id="totalInput">
        <inputExpression id="totalInputExpression" typeRef="number"><text>total</text></inputExpression>
      </input>
      <output id="discountOutput" name="discount" typeRef="number" />
      <rule id="bigSpender">
        <inputEntry id="bigEntry"><text>&gt;= 100</text></inputEntry>
        <outputEntry id="bigDiscount"><text>0.1</text></outputEntry>
      </rule>
      <rule id="regular">
        <inputEntry id="regularEntry"><text>&lt; 100</text></inputEntry>
        <outputEntry id="noDiscount"><text>0</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>`;

const BUSINESS_RULE_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_brt" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="pricing" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-price" sourceRef="start" targetRef="price" />
    <businessRuleTask id="price">
      <extensionElements>
        <zeebe:calledDecision decisionId="discount" resultVariable="discount" />
        <zeebe:ioMapping>
          <zeebe:output source="= discount" target="rebate" />
        </zeebe:ioMapping>
      </extensionElements>
    </businessRuleTask>
    <sequenceFlow id="to-end" sourceRef="price" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

test('business rule tasks evaluate dropped DMN decisions with process variables as input', async () => {
  const { output } = await runBpmn(BUSINESS_RULE_SOURCE, {
    dmn: [DMN_SOURCE],
    variables: { total: 250 },
  });
  assert.deepEqual(output, { rebate: 0.1 });

  const { output: small } = await runBpmn(BUSINESS_RULE_SOURCE, {
    dmn: [DMN_SOURCE],
    variables: { total: 50 },
  });
  assert.deepEqual(small, { rebate: 0 });
});

test('business rule tasks without a matching decision fall back to the service stub', async () => {
  const calls = [];
  const { events } = await runBpmn(BUSINESS_RULE_SOURCE, {
    variables: { total: 250 },
    onServiceCall: (name) => calls.push(name),
  });
  assert.deepEqual(calls, ['discount']);
  assert.equal(events.at(-1).event, 'definition.leave');
});

test('DMN evaluation logs are forwarded through onDmnLog', async () => {
  const entries = [];
  await runBpmn(BUSINESS_RULE_SOURCE, {
    dmn: [DMN_SOURCE],
    variables: { total: 250 },
    onDmnLog: (entry) => entries.push(entry),
  });

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
  assert.ok(
    entries.some((e) => e.message.includes('<discount> input') && e.message.includes('"total": 250')),
    `expected the resolved decision input to be logged, got: ${entries.map((e) => e.message).join(' | ')}`,
  );
});

test('business rule task decisions can invoke registered services', async () => {
  const serviceDmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="feeDefinitions" name="Fees" namespace="https://example.com/dmn/fee">
  <decision id="fee" name="Fee">
    <variable id="feeVariable" name="fee" typeRef="number" />
    <literalExpression id="feeExpression"><text>services.rate(total) * total</text></literalExpression>
  </decision>
</definitions>`;
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_fee" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="fees" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-fee" sourceRef="start" targetRef="charge" />
    <businessRuleTask id="charge">
      <extensionElements>
        <zeebe:calledDecision decisionId="fee" resultVariable="fee" />
        <zeebe:ioMapping>
          <zeebe:output source="= fee" target="fee" />
        </zeebe:ioMapping>
      </extensionElements>
    </businessRuleTask>
    <sequenceFlow id="to-end" sourceRef="charge" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

  const { output } = await runBpmn(source, {
    dmn: [serviceDmn],
    variables: { total: 200 },
    services: { rate: (total) => (total >= 100 ? 0.1 : 0.05) },
  });
  assert.deepEqual(output, { fee: 20 });
});

test('resource diagrams: pricing.bpmn calls discount.dmn via zeebe extensions, both displayable', async () => {
  const bpmn = await readFile(join(resources, 'pricing.bpmn'), 'utf8');
  const dmn = await readFile(join(resources, 'discount.dmn'), 'utf8');

  // both carry diagram interchange so the viewers can draw them
  assert.match(bpmn, /BPMNDiagram/, 'pricing.bpmn should have BPMN DI');
  assert.match(dmn, /dmndi:DMNDI/, 'discount.dmn should have DMN DI');
  assert.match(bpmn, /zeebe:calledDecision/, 'business rule task should use zeebe extensions');

  const decisions = await listDmnDecisions(dmn);
  assert.ok(decisions.length, 'discount.dmn should list decisions');

  const { output } = await runBpmn(bpmn, {
    dmn: [dmn],
    variables: { order: { total: 250 } },
  });
  assert.deepEqual(output, { rebate: 0.1 });
});

test('listDmnDecisions returns decision ids and names for the UI', async () => {
  const decisions = await listDmnDecisions(DMN_SOURCE);
  assert.deepEqual(decisions, [{ id: 'discount', name: 'Discount' }]);
});

test('listDmnDecisions rejects on non-DMN input', async () => {
  await assert.rejects(listDmnDecisions('not dmn at all'));
});

test('timer events run on real timers and surface with their timeout', async () => {
  const timed = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_timer" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="timed" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="pause" />
    <intermediateCatchEvent id="pause">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">PT0.05S</timeDuration>
      </timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="f2" sourceRef="pause" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

  const { events, stats } = await runBpmn(timed);
  assert.equal(events.at(-1).event, 'definition.leave');

  const timer = events.find((e) => e.event === 'activity.timer');
  assert.ok(timer, 'expected an activity.timer event');
  assert.equal(timer.id, 'pause');
  assert.equal(timer.timeout, 50, 'timer entry should carry the timeout in ms');

  const pause = stats.activities.find((a) => a.id === 'pause');
  assert.ok(pause.totalMs >= 40, `timer wait should be part of stats, got ${pause.totalMs}`);
});

test('a running timer can be cancelled through the event api', async () => {
  const timed = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_cancel" targetNamespace="http://bpmn.io/schema/bpmn">
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

  const startedAt = performance.now();
  const { events } = await runBpmn(timed, {
    onEvent(e) {
      if (e.event === 'activity.timer') {
        assert.ok(e.api, 'timer entry should carry an api');
        e.api.cancel();
      }
    },
  });

  assert.equal(events.at(-1).event, 'definition.leave');
  assert.ok(
    events.some((e) => e.event === 'activity.end' && e.id === 'pause'),
    'cancelled timer event should complete, not discard',
  );
  assert.ok(performance.now() - startedAt < 5000, 'run should not wait out the hour');
});

test('timers work with browser-strict receivers — needs bpmn-elements >= 18.0.16', async () => {
  // browsers throw "Illegal invocation" when native setTimeout is invoked on a
  // foreign receiver; since 18.0.16 bpmn-elements destructures before calling,
  // so invoking the stored function the same way must not require a receiver.
  const definition = await createDefinition(SIMPLE_SOURCE);
  const { setTimeout: storedSet, clearTimeout: storedClear } = definition.environment.timers.options;
  const handle = storedSet(() => {}, 10_000);
  storedClear(handle);
});

test('resolves execution performance stats', async () => {
  const { stats } = await runBpmn(SIMPLE_SOURCE);

  assert.equal(typeof stats.duration, 'number');
  assert.ok(stats.duration >= 0);

  const byId = Object.fromEntries(stats.activities.map((a) => [a.id, a]));
  for (const id of ['start', 'task', 'end']) {
    assert.ok(byId[id], `stats missing for ${id}`);
    assert.equal(byId[id].runs, 1, `${id} should have run once`);
    assert.equal(typeof byId[id].totalMs, 'number');
    assert.ok(byId[id].totalMs >= 0);
  }
  assert.equal(byId.task.type, 'bpmn:Task');
  assert.equal(byId.task.name, 'Do the thing');
});

test('stats count repeated runs of looping activities', async () => {
  const bounded = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_statloop" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="retry" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-count" sourceRef="start" targetRef="count" />
    <scriptTask id="count">
      <extensionElements>
        <zeebe:script expression="= count + 1" resultVariable="count" />
      </extensionElements>
    </scriptTask>
    <sequenceFlow id="to-gw" sourceRef="count" targetRef="gw" />
    <exclusiveGateway id="gw" default="back" />
    <sequenceFlow id="back" sourceRef="gw" targetRef="count" />
    <sequenceFlow id="to-end" sourceRef="gw" targetRef="end">
      <conditionExpression xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">= count >= 3</conditionExpression>
    </sequenceFlow>
    <endEvent id="end" />
  </process>
</definitions>`;

  const { stats } = await runBpmn(bounded, { variables: { count: 0 } });
  const count = stats.activities.find((a) => a.id === 'count');
  assert.equal(count.runs, 3);
});

test('stats include time spent waiting', async () => {
  const { stats } = await runBpmn(USER_TASK_SOURCE, {
    onEvent(e) {
      if (e.event === 'activity.wait') setTimeout(() => e.api.signal(), 30);
    },
  });
  const approve = stats.activities.find((a) => a.id === 'approve');
  assert.ok(approve.totalMs >= 25, `expected >= 25ms including wait, got ${approve.totalMs}`);
  assert.ok(stats.duration >= approve.totalMs);
});

test('a boundary event discards the waiting activity and surfaces activity.discard', async () => {
  const bounded = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_bound" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="escalate" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="approve" />
    <userTask id="approve" />
    <boundaryEvent id="timeout" attachedToRef="approve">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">PT0.05S</timeDuration>
      </timerEventDefinition>
    </boundaryEvent>
    <sequenceFlow id="f2" sourceRef="approve" targetRef="end" />
    <sequenceFlow id="f3" sourceRef="timeout" targetRef="escalated" />
    <endEvent id="end" />
    <endEvent id="escalated" />
  </process>
</definitions>`;

  const waits = [];
  const { events } = await runBpmn(bounded, {
    onEvent(e) {
      if (e.event === 'activity.wait' && e.id === 'approve') waits.push(e);
      // never signal — let the boundary timer fire
    },
  });

  assert.ok(waits.length, 'user task should have waited');
  assert.ok(
    events.some((e) => e.event === 'activity.execution.discard' && e.id === 'approve'),
    `expected activity.execution.discard for approve, got: ${events.filter((e) => e.id === 'approve').map((e) => e.event)}`,
  );
  assert.equal(events.at(-1).event, 'definition.leave');
});

function loopDiagram(condition, extra = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_take" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="looping" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-a" sourceRef="start" targetRef="a" />
    <task id="a" />${extra}
    <sequenceFlow id="to-gw" sourceRef="a" targetRef="gw" />
    <exclusiveGateway id="gw" default="to-end" />
    <sequenceFlow id="back" sourceRef="gw" targetRef="a">
      <conditionExpression xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${condition}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="to-end" sourceRef="gw" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;
}

test('takeOnce in a flow condition loops back exactly once', async () => {
  const { events } = await runBpmn(loopDiagram('= takeOnce()'));
  assert.equal(events.at(-1).event, 'definition.leave');
  assert.equal(events.filter((e) => e.event === 'activity.enter' && e.id === 'a').length, 2);
});

test('takeTwice in a flow condition loops back exactly twice', async () => {
  const { events } = await runBpmn(loopDiagram('= takeTwice()'));
  assert.equal(events.at(-1).event, 'definition.leave');
  assert.equal(events.filter((e) => e.event === 'activity.enter' && e.id === 'a').length, 3);
});

test('takeOnce and takeTwice track keys independently', async () => {
  // back-flow keyed separately from an unrelated key consumed up front
  const { events } = await runBpmn(loopDiagram('= takeOnce("retry") and takeOnce("retry")'));
  // both calls share the "retry" key: first call true, second false → never loops
  assert.equal(events.filter((e) => e.event === 'activity.enter' && e.id === 'a').length, 1);

  const twice = await runBpmn(loopDiagram('= if takeOnce("x") then true else takeOnce("y")'));
  // independent keys: x spent on the first pass, y on the second → loops twice
  assert.equal(twice.events.filter((e) => e.event === 'activity.enter' && e.id === 'a').length, 3);
});

test('takeTwice as a zeebe service drives loops via the taken variable', async () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Def_takesvc" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="polling" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-poll" sourceRef="start" targetRef="poll" />
    <serviceTask id="poll">
      <extensionElements>
        <zeebe:taskDefinition type="takeTwice" />
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="to-gw" sourceRef="poll" targetRef="gw" />
    <exclusiveGateway id="gw" default="to-end" />
    <sequenceFlow id="back" sourceRef="gw" targetRef="poll">
      <conditionExpression xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">= taken</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="to-end" sourceRef="gw" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

  const { events } = await runBpmn(source);
  assert.equal(events.at(-1).event, 'definition.leave');
  // taken=true twice (loops back), third call taken=false → exit
  assert.equal(events.filter((e) => e.event === 'activity.enter' && e.id === 'poll').length, 3);
});

test('user services override the take helpers', async () => {
  const { events } = await runBpmn(loopDiagram('= takeOnce()'), {
    services: {
      takeOnce: () => false,
    },
  });
  // service registry override does not touch the FEEL helper — condition still loops once
  assert.equal(events.filter((e) => e.event === 'activity.enter' && e.id === 'a').length, 2);
});

test('camunda 7 style ${...} expressions resolve in flow conditions', async () => {
  let calls = 0;
  const { events } = await runBpmn(loopDiagram('${environment.services.goBack()}'), {
    services: {
      goBack() {
        calls += 1;
        return calls < 2;
      },
    },
  });
  assert.equal(events.at(-1).event, 'definition.leave');
  assert.equal(events.filter((e) => e.event === 'activity.enter' && e.id === 'a').length, 2, 'service-driven condition should loop once');
});

test('warns when a flow condition body is neither FEEL nor a template', async () => {
  const warnings = [];
  await createDefinition(loopDiagram('total &gt;= 3'), { onWarning: (msg) => warnings.push(msg) });
  assert.equal(warnings.length, 1, `expected one warning, got: ${warnings}`);
  assert.match(warnings[0], /<back>/, 'warning should name the flow');
  assert.match(warnings[0], /always/i, 'warning should say the flow is always taken');
});

test('no warning for FEEL or template condition bodies', async () => {
  const warnings = [];
  await createDefinition(loopDiagram('= takeOnce()'), { onWarning: (m) => warnings.push(m) });
  await createDefinition(loopDiagram('${environment.variables.total}'), { onWarning: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
});

test('stopping a running definition settles the run as stopped', async () => {
  const definition = await createDefinition(USER_TASK_SOURCE);
  const done = runDefinition(definition);

  await new Promise((r) => setTimeout(r, 10)); // let it reach the user task wait
  definition.stop();

  const result = await done;
  assert.equal(result.stopped, true);
  assert.ok(result.events.some((e) => e.event === 'activity.wait'), 'events up to the stop are kept');
});

test('rejects on unparsable input', async () => {
  await assert.rejects(runBpmn('this is not xml at all'), (err) => {
    assert.ok(err instanceof Error);
    return true;
  });
});

test('rejects when source has no executable process', async () => {
  const empty = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Def_empty" targetNamespace="http://bpmn.io/schema/bpmn" />`;
  await assert.rejects(runBpmn(empty), /process/i);
});
