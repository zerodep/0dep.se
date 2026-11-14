import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DROPPED_BYTES, readDroppedText } from '../src/runner/dropped-file.js';

const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52);
const BPMN = '<?xml version="1.0" encoding="UTF-8"?>\n<definitions id="Def_dropped" />';

test('resolves the content of a text file', async () => {
  const markdown = '# Title\n\nå, ä and ö\n';
  assert.equal(await readDroppedText(new File([markdown], 'README.md')), markdown);
});

test('resolves XML when XML is required', async () => {
  assert.equal(await readDroppedText(new File([BPMN], 'order.bpmn'), { xml: true }), BPMN);
});

test('a leading byte order mark is ignored', async () => {
  assert.equal(await readDroppedText(new File(['\uFEFF', BPMN], 'order.bpmn'), { xml: true }), BPMN);
  assert.equal(await readDroppedText(new File(['\uFEFF# Title\n'], 'README.md')), '# Title\n');
});

test('XML may start with whitespace', async () => {
  const text = '\n  ' + BPMN;
  assert.equal(await readDroppedText(new File([text], 'order.bpmn'), { xml: true }), text);
});

test('a long text of multi-byte characters is still text, whatever byte they start on', async () => {
  for (const lead of ['', 'a']) {
    const text = lead + 'å'.repeat(20000);
    assert.equal(await readDroppedText(new File([text], 'long.md')), text);
  }
});

test('a file at the size limit is read', async () => {
  const text = '<a>' + ' '.repeat(MAX_DROPPED_BYTES - 3);
  assert.equal((await readDroppedText(new File([text], 'big.bpmn'), { xml: true })).length, MAX_DROPPED_BYTES);
});

test('rejects a binary file, naming it', async () => {
  await assert.rejects(readDroppedText(new File([PNG_BYTES], 'photo.png')), /^Error: photo\.png is not a UTF-8 text file$/);
  await assert.rejects(readDroppedText(new File([PNG_BYTES], 'photo.bpmn'), { xml: true }), /photo\.bpmn is not a UTF-8 text file/);
});

test('rejects text in another encoding', async () => {
  const latin1 = Buffer.from('<userTask id="approve" name="Godkänn order" />', 'latin1');
  await assert.rejects(readDroppedText(new File([latin1], 'latin1.bpmn'), { xml: true }), /latin1\.bpmn is not a UTF-8 text file/);

  const utf16 = Buffer.from(BPMN, 'utf16le');
  await assert.rejects(readDroppedText(new File([utf16], 'utf16.bpmn'), { xml: true }), /utf16\.bpmn is not a UTF-8 text file/);
});

test('a binary file is rejected without being read in full', async () => {
  class Unreadable extends File {
    text() {
      assert.fail('the whole file must not be read');
    }
    arrayBuffer() {
      assert.fail('the whole file must not be read');
    }
  }
  const bytes = new Uint8Array(1024 * 1024);
  bytes.set(PNG_BYTES);
  await assert.rejects(readDroppedText(new Unreadable([bytes], 'photo.png')), /not a UTF-8 text file/);
});

test('rejects a file over the size limit without reading it, stating the limit', async () => {
  const file = {
    name: 'film.bpmn',
    size: MAX_DROPPED_BYTES + 1,
    slice: () => assert.fail('an oversized file must not be read'),
    text: () => assert.fail('an oversized file must not be read'),
  };
  await assert.rejects(readDroppedText(file, { xml: true }), /^Error: film\.bpmn is too large \(5\.1 MB\) — the limit is 5 MB$/);
});

test('rejects text that is not XML when XML is required', async () => {
  const json = new File(['{ "order": { "total": 250 } }'], 'order.json');
  await assert.rejects(readDroppedText(json, { xml: true }), /^Error: order\.json is not an XML file$/);
  await assert.rejects(readDroppedText(new File(['just some notes'], 'notes.txt'), { xml: true }), /notes\.txt is not an XML file/);
  await assert.rejects(readDroppedText(new File([''], 'empty.bpmn'), { xml: true }), /empty\.bpmn is not an XML file/);

  assert.equal(await readDroppedText(json), '{ "order": { "total": 250 } }', 'the same file is fine where any text will do');
});
