/**
 * Pure logic behind the /toc/ page — markdown table of contents via @0dep/toc.
 * No DOM, no I/O, so it is unit tested with node:test and bundled for the browser.
 */
import { buildToc, renderToc, findMarkers } from '@0dep/toc';

const NEWLINE = /\r?\n/;

/**
 * Regenerate every toc in `source`. With marker pairs the library does the work
 * and each pair is reported with a one based line and a status. Without markers
 * the block lists every heading (wrapped per `options`) and the returned document
 * has it inserted below the first heading as a starting point.
 *
 * @param {string} source markdown
 * @param {{ collapsible?: boolean|string, collapsed?: boolean|string }} [options] used only when the source has no markers
 */
export function evaluateToc(source, options = {}) {
  const markers = findMarkers(source);
  if (markers.length === 0) return withoutMarkers(source, options);

  const output = buildToc(source);
  const changed = output !== source;
  const before = source.split(NEWLINE);
  const after = output.split(NEWLINE);
  const afterMarkers = findMarkers(output);
  const aligned = afterMarkers.length === markers.length;
  const blocks = [];
  const pairs = markers.map((pair, i) => {
    const line = (pair.start === -1 ? pair.end : pair.start) + 1;
    const skipped = (message) => ({ line, status: 'skipped', message: `${message}, skipped` });
    if (pair.problem) return skipped(pair.problem);
    if (pair.start === -1) return skipped('TOC end marker without start marker');
    if (pair.end === -1) return skipped('TOC start marker without end marker');
    const block = renderToc(source, pair.start, pair.options);
    if (!block) return skipped('no headings below TOC start marker');
    blocks.push(block);
    let same = !changed;
    if (changed && aligned) {
      const previous = before.slice(pair.start, pair.end + 1).join('\n');
      const next = after.slice(afterMarkers[i].start, afterMarkers[i].end + 1).join('\n');
      same = previous === next;
    }
    return same ? { line, status: 'up to date', message: 'TOC already up to date' } : { line, status: 'updated', message: 'TOC updated' };
  });

  const updated = pairs.filter((p) => p.status === 'updated').length;
  const fresh = pairs.filter((p) => p.status === 'up to date').length;
  const usable = updated + fresh;
  let summary;
  if (usable === 0) summary = `${plural(pairs.length, 'toc')} skipped`;
  else if (updated === 0) summary = `${plural(fresh, 'toc')} already up to date`;
  else summary = `${plural(updated, 'toc')} updated`;
  if (usable > 0 && pairs.length > usable) summary += `, ${pairs.length - usable} skipped`;

  return { hasMarkers: true, pairs, block: blocks.join('\n\n'), output, changed, summary };
}

function withoutMarkers(source, options) {
  const block = renderToc(source, -1, options);
  if (!block) {
    return { hasMarkers: false, pairs: [], block: '', output: source, changed: false, summary: 'No headings found' };
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(NEWLINE);
  const heading = lines.findIndex((l) => /^ {0,3}#{1,6}(\s|$)/.test(l));
  const insertAt = heading === -1 ? 0 : heading + 1;
  const withBlock = [...lines.slice(0, insertAt), '', block, '', ...lines.slice(insertAt)];
  const output = collapseBlankLines(withBlock).join(eol).replace(/\n/g, eol);
  return { hasMarkers: false, pairs: [], block, output, changed: true, summary: 'No toc markers — every heading listed' };
}

// keep at most one blank line around the inserted block
function collapseBlankLines(lines) {
  const out = [];
  for (const line of lines) {
    if (line === '' && out[out.length - 1] === '') continue;
    out.push(line);
  }
  while (out.length && out[0] === '') out.shift();
  return out;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
