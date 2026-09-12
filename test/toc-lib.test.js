import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateToc } from '../src/runner/toc-lib.js';

const withMarkers = '# Title\n\n<!-- toc -->\n<!-- /toc -->\n\n## Install\n\n## Usage `api`\n\n### Options\n';

test('a document with markers gets its toc regenerated between them', () => {
  const result = evaluateToc(withMarkers);
  assert.equal(result.hasMarkers, true);
  assert.equal(result.changed, true);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].line, 3, 'line numbers are one based');
  assert.equal(result.pairs[0].status, 'updated');
  assert.match(result.output, /<!-- toc -->\n\n- \[Install\]\(#install\)\n- \[Usage `api`\]\(#usage-api\)\n  - \[Options\]\(#options\)\n\n<!-- \/toc -->/);
  assert.ok(result.output.startsWith('# Title\n'), 'nothing above the marker is touched');
  assert.equal(result.block, '<!-- toc -->\n\n- [Install](#install)\n- [Usage `api`](#usage-api)\n  - [Options](#options)\n\n<!-- /toc -->');
});

test('a document whose toc is already fresh reports up to date and is returned unchanged', () => {
  const fresh = evaluateToc(withMarkers).output;
  const result = evaluateToc(fresh);
  assert.equal(result.changed, false);
  assert.equal(result.output, fresh);
  assert.equal(result.pairs[0].status, 'up to date');
});

test('a document without markers gets a toc of every heading as a starting point', () => {
  const source = '# Title\n\nIntro.\n\n## Install\n\n## Usage\n';
  const result = evaluateToc(source);
  assert.equal(result.hasMarkers, false);
  assert.equal(result.pairs.length, 0);
  assert.match(result.block, /- \[Title\]\(#title\)\n  - \[Install\]\(#install\)\n  - \[Usage\]\(#usage\)/);
  // the output document has the block inserted below the first heading, ready to paste back
  assert.equal(result.changed, true);
  assert.equal(result.output, `# Title\n\n${result.block}\n\nIntro.\n\n## Install\n\n## Usage\n`);
});

test('without markers the form options decide how the block is wrapped', () => {
  const source = '# Title\n\n## Install\n';
  const collapsed = evaluateToc(source, { collapsed: 'Contents' });
  assert.match(collapsed.block, /^<!-- toc collapsed="Contents" -->\n<details>\n<summary>Contents<\/summary>/);
  const collapsible = evaluateToc(source, { collapsible: true });
  assert.match(collapsible.block, /^<!-- toc collapsible -->\n<details open>/);
});

test('with markers the marker options win over the form options', () => {
  const source = '# Title\n\n<!-- toc collapsed -->\n<!-- /toc -->\n\n## Install\n';
  const result = evaluateToc(source, { collapsible: true });
  assert.match(result.block, /^<!-- toc collapsed -->\n<details>/);
  assert.doesNotMatch(result.output, /collapsible/);
});

test('a document without headings yields nothing to list', () => {
  const result = evaluateToc('Just prose.\n');
  assert.equal(result.hasMarkers, false);
  assert.equal(result.block, '');
  assert.equal(result.changed, false);
  assert.equal(result.output, 'Just prose.\n');
});

test('a document without headings but with markers is left alone', () => {
  const source = '<!-- toc -->\n<!-- /toc -->\n\nprose\n';
  const result = evaluateToc(source);
  assert.equal(result.hasMarkers, true);
  assert.equal(result.changed, false);
  assert.equal(result.output, source);
  assert.equal(result.pairs[0].status, 'skipped');
  assert.match(result.pairs[0].message, /no headings below/);
});

test('problem pairs are reported with their line and left alone', () => {
  const source = [
    '# Title',
    '',
    '<!-- toc -->',
    '<!-- /toc -->',
    '',
    '## A',
    '',
    '<!-- toc collapsable -->',
    '<!-- /toc -->',
    '',
    '## B',
    '',
    '<!-- toc -->',
    '',
    '## C',
    '',
    '<!-- /toc -->',
    '',
    '<!-- /toc -->',
    '',
  ].join('\n');
  const result = evaluateToc(source);
  assert.equal(result.hasMarkers, true);
  assert.equal(result.changed, true);
  const statuses = result.pairs.map((p) => [p.line, p.status]);
  assert.deepEqual(statuses, [
    [3, 'updated'],
    [8, 'skipped'],
    [13, 'updated'],
    [19, 'skipped'],
  ]);
  assert.match(result.pairs[1].message, /unknown TOC option collapsable/);
  assert.match(result.pairs[3].message, /end marker without start marker/);
  assert.match(result.output, /<!-- toc collapsable -->\n<!-- \/toc -->/, 'problem pair stays empty');
  // the block shows every usable pair, in document order
  assert.match(result.block, /- \[A\]\(#a\)[\s\S]*- \[C\]\(#c\)/);
  assert.equal(result.block.split('<!-- toc -->').length - 1, 2);
});

test('a start marker without an end marker is skipped', () => {
  const result = evaluateToc('# T\n\n<!-- toc -->\n\n## A\n');
  assert.equal(result.pairs[0].status, 'skipped');
  assert.match(result.pairs[0].message, /start marker without end marker/);
  assert.equal(result.changed, false);
});

test('crlf line endings are preserved', () => {
  const result = evaluateToc('# Title\r\n\r\n<!-- toc -->\r\n<!-- /toc -->\r\n\r\n## Install\r\n');
  assert.ok(result.output.includes('<!-- toc -->\r\n\r\n- [Install](#install)\r\n'));
  assert.equal(result.pairs[0].status, 'updated');
});

test('summary counts what happened', () => {
  assert.equal(evaluateToc(withMarkers).summary, '1 toc updated');
  assert.equal(evaluateToc(evaluateToc(withMarkers).output).summary, '1 toc already up to date');
  assert.equal(evaluateToc('# T\n\n## A\n').summary, 'No toc markers — every heading listed');
  assert.equal(evaluateToc('prose\n').summary, 'No headings found');
  assert.equal(evaluateToc('').summary, 'No headings found');
});
