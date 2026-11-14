/**
 * Parse XML with a moddle, reporting what the parser could not make sense of.
 *
 * @param {{ fromXML: (xml: string) => Promise<object> }} moddle
 * @param {string} source
 * @param {(message: string) => void} [onWarning] receives each parser warning,
 *   also those of a source that is rejected
 * @returns {Promise<object>} the parse result of the moddle
 */
export async function parseXml(moddle, source, onWarning) {
  try {
    const parsed = await moddle.fromXML(String(source));
    report(parsed.warnings, onWarning);
    return parsed;
  } catch (err) {
    report(err?.warnings, onWarning);
    throw err;
  }
}

function report(warnings, onWarning) {
  if (!onWarning) return;
  for (const { message } of warnings || []) onWarning(message);
}
