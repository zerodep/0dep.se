import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStaticServer } from '../src/serve.js';

let root;
let server;
let base;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'zerodep-serve-'));
  await mkdir(join(root, 'run'));
  await writeFile(join(root, 'index.html'), '<h1>home</h1>');
  await writeFile(join(root, 'run', 'index.html'), '<h1>run</h1>');
  await writeFile(join(root, 'styles.css'), 'body{}');
  await writeFile(join(root, 'blob.bin'), 'x');
  server = createStaticServer(root);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

test('serves index.html at the root with an html content type', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await res.text(), '<h1>home</h1>');
});

test('resolves directories to their index.html', async () => {
  const res = await fetch(`${base}/run/`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>run</h1>');
});

test('maps known extensions and falls back to octet-stream', async () => {
  assert.equal((await fetch(`${base}/styles.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(`${base}/blob.bin`)).headers.get('content-type'), 'application/octet-stream');
});

test('ignores the query string', async () => {
  const res = await fetch(`${base}/styles.css?v=1`);
  assert.equal(res.status, 200);
});

test('responds 404 for missing files', async () => {
  const res = await fetch(`${base}/nope.html`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');
});

test('refuses paths that escape the root', async () => {
  // fetch normalises "..", so send the raw request line over a socket
  const { connect } = await import('node:net');
  const socket = connect(server.address().port, 'localhost');
  const response = new Promise((resolve) => {
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
  });
  socket.write('GET /../package.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  const raw = await response;
  assert.match(raw, /^HTTP\/1\.1 403/);
});

test('responds 500 on malformed percent-encoding', async () => {
  const res = await fetch(`${base}/%E0%A4%A`);
  assert.equal(res.status, 500);
});
