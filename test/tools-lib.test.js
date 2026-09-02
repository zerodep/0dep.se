import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateIso, evaluateOcr, createHistory } from '../src/runner/tools-lib.js';

describe('evaluateIso', () => {
  test('auto-detects an interval with repeat, start and duration', () => {
    const r = evaluateIso('R3/2024-03-01T10:00Z/P1M');
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'interval');
    assert.deepEqual(r.flags, ['repeat', 'start', 'duration']);
    assert.equal(r.repeat, 3);
    assert.equal(r.startAt, '2024-05-01T10:00:00.000Z');
    assert.equal(r.expireAt, '2024-06-01T10:00:00.000Z');
    assert.equal(r.normalized, 'R3/2024-03-01T10:00:00.000Z/P1M');
  });

  test('auto-detects a duration and reports milliseconds', () => {
    const r = evaluateIso('P1Y2M3DT4H', { now: new Date(0) });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'duration');
    assert.equal(r.milliseconds, 36907200000);
    assert.equal(r.expireAt, '1971-03-04T04:00:00.000Z');
    assert.equal(r.sign, 1);
    assert.equal(r.startAt, undefined, 'a duration has no absolute start without a reference');
      });

  test('unbounded repeats read as forever, or until the end date', () => {
    const forever = evaluateIso('R-1/2009-07-01T00:00Z/P1M');
    assert.equal(forever.repeat, -1);
    assert.equal(forever.repeatText, 'forever');
    const untilEnd = evaluateIso('R-1/P1M/2024-07-27T00:00Z');
    assert.equal(untilEnd.repeatText, 'until the end date');
    const counted = evaluateIso('R3/2024-03-01T10:00Z/P1M');
    assert.equal(counted.repeatText, '3 times');
    assert.equal(evaluateIso('2007-03-01/2007-04-01').repeatText, undefined, 'no repeat, no text');
  });

  test('negative durations carry their sign', () => {
    const r = evaluateIso('-P1D');
    assert.equal(r.kind, 'duration');
    assert.equal(r.sign, -1);
  });

  test('auto-detects a date, enforceUTC controls the zone of zone-less input', () => {
    const local = evaluateIso('2024-02-29T12:00');
    assert.equal(local.ok, true);
    assert.equal(local.kind, 'date');
    const utc = evaluateIso('2024-02-29T12:00', { enforceUTC: true });
    assert.equal(utc.date, '2024-02-29T12:00:00.000Z');
    assert.equal(utc.week, '2024-W09-4');
  });

  test('forced kind is respected', () => {
    const r = evaluateIso('2024-03-01', { kind: 'interval' });
    assert.equal(r.kind, 'interval');
    assert.deepEqual(r.flags, ['start']);
    assert.equal(r.startAt, r.expireAt, 'start-only interval is a point in time');
  });

  test('invalid input yields an error with the parser message, never throws', () => {
    const r = evaluateIso('2023-02-29');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'date');
    assert.match(r.error, /Invalid ISO 8601 date/);

    const d = evaluateIso('P0.5YT3S', { kind: 'duration' });
    assert.equal(d.ok, false);
    assert.match(d.error, /./);
  });

  test('blank input is an error', () => {
    assert.equal(evaluateIso('   ').ok, false);
  });
});

describe('evaluateOcr', () => {
  test('generate returns the invoice number with its control digits', () => {
    const r = evaluateOcr('Customer007:Date2019-12-24:Amount$200', { mode: 'generate' });
    assert.equal(r.ok, true);
    assert.equal(r.numbers, '0072019122420063');
    assert.equal(r.lengthControl, 6);
    assert.equal(r.control, 3);
    assert.equal(r.length, 16);
    assert.equal(r.sum, 37);
  });

  test('generate with fixed length pads with zeros', () => {
    const r = evaluateOcr('123', { mode: 'generate', fixedLength: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.numbers, '0000012302');
  });

  test('generate caps to maxLength from the left', () => {
    const r = evaluateOcr('12345678901234567890123456', { mode: 'generate', maxLength: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.numbers, '9012345600');
    assert.equal(r.length, 10);
  });

  test('validate reports out-of-range references', () => {
    const r = evaluateOcr('1', { mode: 'validate' });
    assert.equal(r.ok, true);
    assert.equal(r.valid, false);
    assert.equal(r.errorCode, 'ERR_OCR_OUT_OF_RANGE');
  });

  test('validate reports all algorithms', () => {
    const r = evaluateOcr('0072019122420063', { mode: 'validate' });
    assert.equal(r.ok, true);
    assert.equal(r.valid, true);
    assert.equal(r.control, 3);
    assert.equal(r.sum, 37);
    assert.deepEqual(r.algorithms, { soft: true, hard: true, variableLength: true });
  });

  test('validate with fixed lengths checks either length', () => {
    const r = evaluateOcr('0072019122420063', { mode: 'validate', fixedLength: 12, fixedLength2: 16 });
    assert.equal(r.algorithms.fixedLength, true);
    const miss = evaluateOcr('0072019122420063', { mode: 'validate', fixedLength: 12 });
    assert.equal(miss.algorithms.fixedLength, false);
  });

  test('validate flags a bad control digit and sneaky characters', () => {
    const bad = evaluateOcr('00720191224200637', { mode: 'validate' });
    assert.equal(bad.ok, true);
    assert.equal(bad.valid, false);
    assert.equal(bad.control, 0, 'expected control digit is reported');
    const sneaky = evaluateOcr('0072019122420063A', { mode: 'validate' });
    assert.equal(sneaky.valid, false);
    assert.equal(sneaky.errorCode, 'ERR_OCR_INVALID_CHAR');
    assert.match(sneaky.error, /char/i);
  });

  test('blank input is an error', () => {
    assert.equal(evaluateOcr('', { mode: 'validate' }).ok, false);
    assert.equal(evaluateOcr('', { mode: 'generate' }).ok, false);
  });
});

describe('createHistory', () => {
  function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
      data,
    };
  }

  test('starts empty and persists pushed entries newest first', () => {
    const storage = memoryStorage();
    const history = createHistory(storage, { key: 'k', max: 3 });
    assert.deepEqual(history.list(), []);
    history.push({ tool: 'iso', input: 'P1D', options: {}, summary: 'duration' });
    history.push({ tool: 'ocr', input: '123', options: { mode: 'generate' }, summary: '12345' });
    const list = history.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].tool, 'ocr');
    assert.equal(typeof list[0].at, 'string');
    assert.match(list[0].at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(list[0].id, 'entries get an id');

    const reloaded = createHistory(storage, { key: 'k', max: 3 });
    assert.equal(reloaded.list().length, 2, 'persisted in storage');
  });

  test('dedupes identical attempts by moving them to the top and caps at max', () => {
    const history = createHistory(memoryStorage(), { key: 'k', max: 3 });
    history.push({ tool: 'iso', input: 'P1D', options: {} });
    history.push({ tool: 'iso', input: 'P2D', options: {} });
    history.push({ tool: 'iso', input: 'P1D', options: {} });
    assert.deepEqual(history.list().map((e) => e.input), ['P1D', 'P2D']);
    history.push({ tool: 'iso', input: 'P3D', options: {} });
    history.push({ tool: 'iso', input: 'P4D', options: {} });
    assert.deepEqual(history.list().map((e) => e.input), ['P4D', 'P3D', 'P1D']);
  });

  test('different options are different attempts', () => {
    const history = createHistory(memoryStorage(), { key: 'k', max: 10 });
    history.push({ tool: 'iso', input: 'P1D', options: { enforceUTC: false } });
    history.push({ tool: 'iso', input: 'P1D', options: { enforceUTC: true } });
    assert.equal(history.list().length, 2);
  });

  test('remove and clear', () => {
    const storage = memoryStorage();
    const history = createHistory(storage, { key: 'k', max: 10 });
    history.push({ tool: 'iso', input: 'P1D', options: {} });
    history.push({ tool: 'iso', input: 'P2D', options: {} });
    history.remove(history.list()[0].id);
    assert.deepEqual(history.list().map((e) => e.input), ['P1D']);
    history.clear();
    assert.deepEqual(history.list(), []);
    assert.equal(storage.getItem('k'), null, 'clear removes the key');
  });

  test('survives corrupt or unavailable storage', () => {
    const corrupt = createHistory(memoryStorage({ k: '{not json' }), { key: 'k', max: 10 });
    assert.deepEqual(corrupt.list(), []);
    const throwing = createHistory({
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
      removeItem() { throw new Error('denied'); },
    }, { key: 'k', max: 10 });
    assert.deepEqual(throwing.list(), []);
    throwing.push({ tool: 'iso', input: 'P1D', options: {} });
    assert.equal(throwing.list().length, 1, 'in-memory list still works');
    const none = createHistory(null, { key: 'k', max: 10 });
    none.push({ tool: 'iso', input: 'P1D', options: {} });
    assert.equal(none.list().length, 1);
  });
});
