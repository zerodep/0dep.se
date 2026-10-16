/**
 * Pure logic behind the /tools/ page — ISO 8601 parsing via @0dep/piso,
 * bankgiro OCR validation/generation via ocrgenerator, and a small
 * storage-backed attempt history. No DOM in here so node:test covers it.
 */
import { parseInterval, parseDuration, getDate, getISOWeekString } from '@0dep/piso';
import {
  generate,
  fixed,
  validate,
  validateSoft,
  validateHard,
  validateVariableLength,
  validateFixedLength,
  MIN_LENGTH,
  MAX_LENGTH,
} from 'ocrgenerator';

const FLAG_NAMES = [
  [1, 'repeat'],
  [2, 'start'],
  [4, 'duration'],
  [8, 'end'],
];

/** R-1 declares unbounded repetition — it runs forever, or until the interval's end date. */
function describeRepeat(repeat, hasEnd) {
  if (repeat === undefined || repeat === null) return undefined;
  if (repeat === -1) return hasEnd ? 'until the end date' : 'forever';
  return `${repeat} times`;
}

/**
 * The interval's first start and last end. One of them may be missing from the source —
 * `P1Y/2025-05-01` or `R3/2024-03-01/P1M` — but follows from the other bound, the duration
 * and the repeat count. An unbounded repeat (R-1) has no such bound and leaves it undefined.
 */
function intervalBounds(interval) {
  const { startDate, endDate, duration, repeat } = interval;
  const bounded = duration && repeat !== -1;
  const times = repeat ?? 1;
  const start = startDate ?? (bounded && endDate ? duration.getStartAt(endDate, times) : null);
  const end = endDate ?? (bounded && startDate ? duration.getExpireAt(startDate, times) : null);
  return {
    start: start ? start.toISOString() : undefined,
    startDerived: start && !startDate ? true : undefined,
    end: end ? end.toISOString() : undefined,
    endDerived: end && !endDate ? true : undefined,
  };
}

/** Guess what the user pasted: an interval has a slash (P1D/2024-03-05 included), a duration starts with (−)P, else a date. */
export function detectIsoKind(source) {
  const s = source.trim();
  if (s.includes('/')) return 'interval';
  if (/^[-−+]?P/i.test(s)) return 'duration';
  return 'date';
}

/**
 * @param {string} source
 * @param {{ kind?: 'auto'|'interval'|'duration'|'date', enforceUTC?: boolean, now?: Date }} [options]
 */
export function evaluateIso(source, { kind = 'auto', enforceUTC = false, now = new Date() } = {}) {
  const input = String(source ?? '').trim();
  const resolved = kind === 'auto' ? detectIsoKind(input) : kind;
  if (!input) return { ok: false, kind: resolved, error: 'Nothing to parse' };

  try {
    switch (resolved) {
      case 'interval': {
        const interval = parseInterval(input, enforceUTC);
        const startAt = interval.getStartAt(now);
        const expireAt = interval.getExpireAt(now);
        const { start, startDerived, end, endDerived } = intervalBounds(interval);
        return {
          ok: true,
          kind: 'interval',
          type: interval.type,
          flags: FLAG_NAMES.filter(([bit]) => (interval.type & bit) === bit).map(([, name]) => name),
          repeat: interval.repeat,
          repeatText: describeRepeat(interval.repeat, Boolean(interval.endDate)),
          normalized: interval.toJSON(),
          start,
          startDerived,
          end,
          endDerived,
          duration: interval.duration ? interval.duration.toString() : undefined,
          startAt: startAt ? startAt.toISOString() : undefined,
          expireAt: expireAt ? expireAt.toISOString() : undefined,
        };
      }
      case 'duration': {
        const duration = parseDuration(input);
        // the parsed result carries the sign and the parser's own validity flag next to the designators
        const { sign = 1, isValid: _valid, ...designators } = duration.result ?? {};
        return {
          ok: true,
          kind: 'duration',
          sign,
          normalized: duration.toString(),
          designators,
          milliseconds: duration.toMilliseconds(now),
          expireAt: duration.getExpireAt(now).toISOString(),
        };
      }
      default: {
        const date = getDate(input, enforceUTC);
        return {
          ok: true,
          kind: 'date',
          date: date.toISOString(),
          epoch: date.getTime(),
          week: getISOWeekString(date).slice(0, 10),
          weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()],
        };
      }
    }
  } catch (err) {
    return { ok: false, kind: resolved, error: err.message };
  }
}

function toLength(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * @param {string} source
 * @param {{ mode: 'validate'|'generate', fixedLength?: number, fixedLength2?: number, minLength?: number, maxLength?: number }} options
 */
export function evaluateOcr(source, { mode = 'validate', fixedLength, fixedLength2, minLength, maxLength } = {}) {
  const input = String(source ?? '').trim();
  const fixedLen = toLength(fixedLength);
  const fixedLen2 = toLength(fixedLength2);
  const range = {
    minLength: toLength(minLength) ?? MIN_LENGTH,
    maxLength: toLength(maxLength) ?? MAX_LENGTH,
  };
  if (!input) return { ok: false, mode, error: mode === 'generate' ? 'Nothing to generate from' : 'Nothing to validate' };

  try {
    if (mode === 'generate') {
      const result = fixedLen ? fixed(input, fixedLen) : generate(input, range);
      if (typeof result === 'string') {
        const check = validate(result);
        return { ok: true, mode, numbers: result, length: result.length, control: check.control, sum: check.sum, fixedLength: fixedLen };
      }
      if (result.error_code) {
        return { ok: false, mode, errorCode: result.error_code, error: result.message || result.error_code };
      }
      return { ok: true, mode, numbers: result.numbers, lengthControl: result.lengthControl, control: result.control, length: result.length, sum: result.sum };
    }

    const result = validate(input, range);
    const algorithms = {
      soft: validateSoft(input),
      hard: validateHard(input),
      variableLength: validateVariableLength(input),
    };
    if (fixedLen) algorithms.fixedLength = validateFixedLength(input, fixedLen, fixedLen2);
    return {
      ok: true,
      mode,
      valid: result.valid,
      control: result.control,
      sum: result.sum,
      length: input.length,
      errorCode: result.error_code,
      error: result.message,
      algorithms,
    };
  } catch (err) {
    return { ok: false, mode, error: err.message };
  }
}

/**
 * Attempt history persisted in a Storage-like object (localStorage). Tolerates
 * missing, throwing (private mode, blocked site data) and corrupt storage by
 * falling back to memory only.
 */
export function createHistory(storage, { key = 'tools-history', max = 50 } = {}) {
  let entries = load();

  function load() {
    try {
      const raw = storage?.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.input === 'string') : [];
    } catch {
      return [];
    }
  }

  function save() {
    try {
      if (entries.length) storage?.setItem(key, JSON.stringify(entries));
      else storage?.removeItem(key);
    } catch {
      /* storage unavailable — keep the in-memory list */
    }
  }

  function sameAttempt(a, b) {
    return a.tool === b.tool && a.input === b.input && JSON.stringify(a.options ?? {}) === JSON.stringify(b.options ?? {});
  }

  return {
    list: () => entries.slice(),
    push(entry) {
      const record = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        tool: entry.tool,
        input: entry.input,
        options: entry.options ?? {},
        summary: entry.summary,
      };
      entries = [record, ...entries.filter((e) => !sameAttempt(e, record))].slice(0, max);
      save();
      return record;
    },
    remove(id) {
      entries = entries.filter((e) => e.id !== id);
      save();
    },
    clear() {
      entries = [];
      save();
    },
  };
}
