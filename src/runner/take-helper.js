/**
 * Flow-control helper backing `takeOnce`/`takeTwice`. In a FEEL invocation
 * (`takeOnce()`, `services.takeOnce("grant")`) it returns true the first
 * `limit` times per key and false after — handy to make circular BPMN demo
 * diagrams terminate, or to grant a DMN decision branch once per evaluation.
 * As a zeebe job type it completes the job with `{ taken }`, counted per
 * activity id, for `= taken` conditions downstream.
 */
export function makeTakeHelper(limit) {
  const counts = new Map();
  function bump(key) {
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    return n <= limit;
  }
  return function take(keyOrMessage, callback) {
    if (typeof callback === 'function') {
      return callback(null, { taken: bump(`service:${keyOrMessage?.content?.id || ''}`) });
    }
    return bump(typeof keyOrMessage === 'string' ? keyOrMessage : '$default');
  };
}
