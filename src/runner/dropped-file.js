/** Largest dropped file the runner pages accept, in bytes. */
export const MAX_DROPPED_BYTES = 5 * 1024 * 1024;

const SNIFFED_BYTES = 4096;
const MEGABYTE = 1024 * 1024;

/**
 * Read a file dropped on a runner page as text, so that nothing but a
 * reasonably sized text file reaches the page.
 *
 * @param {File} file
 * @param {object} [options]
 * @param {boolean} [options.xml] the content has to be XML
 * @returns {Promise<string>} the content of the file, without a leading byte
 *   order mark
 * @throws {Error} when the file is larger than `MAX_DROPPED_BYTES`, is not
 *   UTF-8 text or, with `xml`, is not XML — the message names the file and is
 *   meant to be shown to the user
 */
export async function readDroppedText(file, { xml = false } = {}) {
  const name = file.name || 'the dropped file';
  if (file.size > MAX_DROPPED_BYTES) {
    throw new Error(`${name} is too large (${megabytes(file.size)} MB) — the limit is ${megabytes(MAX_DROPPED_BYTES)} MB`);
  }

  const head = decodeText(new Uint8Array(await file.slice(0, SNIFFED_BYTES).arrayBuffer()));
  if (head === null) throw new Error(`${name} is not a UTF-8 text file`);
  if (xml && !head.trimStart().startsWith('<')) throw new Error(`${name} is not an XML file`);

  return file.text();
}

function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    // streaming, since the sniffed bytes may end in the middle of a character
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return null;
  }
}

function megabytes(bytes) {
  return Math.ceil((bytes / MEGABYTE) * 10) / 10;
}
