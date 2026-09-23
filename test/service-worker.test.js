import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const distDir = join(repoRoot, 'dist');
const pages = ['run', 'dmn', 'tools', 'toc'];
const origin = 'https://0dep.se';

before(async () => {
  const { build } = await import('../src/build.js');
  await build();
});

// Runs a generated sw.js in a sandbox with fake caches + fetch, and hands back its event listeners.
function loadWorker(source, { network, cached = {} } = {}) {
  const stores = new Map();
  const openStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const keyOf = (req) => new URL(typeof req === 'string' ? req : req.url, origin).pathname;
  const cacheFor = (name) => {
    const store = openStore(name);
    return {
      async addAll(reqs) {
        for (const req of reqs) store.set(keyOf(req), await sandbox.fetch(req));
      },
      async put(req, res) {
        store.set(keyOf(req), res);
      },
      async match(req) {
        return store.get(keyOf(req));
      },
    };
  };
  for (const [name, entries] of Object.entries(cached)) {
    for (const [path, body] of Object.entries(entries)) openStore(name).set(path, new Response(body));
  }
  const listeners = {};
  const fetched = [];
  const sandbox = {
    URL,
    Request: class extends Request {
      constructor(input, init) {
        super(new URL(typeof input === 'string' ? input : input.url, origin), init);
      }
    },
    Response,
    fetch: async (req) => {
      const request = typeof req === 'string' ? new Request(new URL(req, origin)) : req;
      fetched.push(request);
      return network(request);
    },
    caches: {
      open: async (name) => cacheFor(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      match: async (req) => {
        for (const name of stores.keys()) {
          const hit = await cacheFor(name).match(req);
          if (hit) return hit;
        }
      },
    },
    self: {
      location: { origin },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
  };
  vm.runInNewContext(source, sandbox);

  const dispatch = async (type, extra = {}) => {
    const pending = [];
    let responded;
    listeners[type]({
      ...extra,
      waitUntil: (p) => pending.push(p),
      respondWith: (p) => {
        responded = p;
      },
    });
    await Promise.all(pending);
    const res = await responded;
    await Promise.all(pending);
    return res;
  };
  return { stores, fetched, dispatch };
}

const cacheName = (source) => source.match(/const CACHE = '([^']+)'/)[1];

for (const page of pages) {
  test(`${page} sw precaches past the browser's HTTP cache`, async () => {
    const source = await readFile(join(distDir, page, 'sw.js'), 'utf8');
    const sw = loadWorker(source, { network: () => new Response('fresh') });
    await sw.dispatch('install');
    assert.ok(sw.fetched.length > 0, 'install should fetch the assets');
    for (const req of sw.fetched) {
      assert.equal(req.cache, 'reload', `${req.url} should be fetched with cache: 'reload'`);
    }
  });

  test(`${page} sw serves the network version when online, not a stale cached copy`, async () => {
    const source = await readFile(join(distDir, page, 'sw.js'), 'utf8');
    const name = cacheName(source);
    const sw = loadWorker(source, {
      network: () => new Response('new deploy'),
      cached: { [name]: { [`/${page}/app.js`]: 'old deploy' } },
    });
    const res = await sw.dispatch('fetch', { request: new Request(`${origin}/${page}/app.js`) });
    assert.equal(await res.text(), 'new deploy');
    const refreshed = await sw.stores.get(name).get(`/${page}/app.js`);
    assert.equal(await refreshed.text(), 'new deploy', 'the cache should be refreshed for offline use');
  });

  test(`${page} sw falls back to the cache when offline`, async () => {
    const source = await readFile(join(distDir, page, 'sw.js'), 'utf8');
    const name = cacheName(source);
    const sw = loadWorker(source, {
      network: () => Promise.reject(new TypeError('Failed to fetch')),
      cached: { [name]: { [`/${page}/`]: 'offline copy' } },
    });
    const res = await sw.dispatch('fetch', { request: new Request(`${origin}/${page}/`) });
    assert.equal(await res.text(), 'offline copy');
  });

  test(`${page} sw version covers every precached file`, async () => {
    const source = await readFile(join(distDir, page, 'sw.js'), 'utf8');
    const assets = JSON.parse(source.match(/const ASSETS = (\[[\s\S]*?\]);/)[1]);
    const hash = createHash('sha256');
    for (const url of assets) {
      if (url.endsWith('/')) continue; // the directory URL serves index.html, listed separately
      hash.update(await readFile(join(distDir, url)));
    }
    assert.equal(cacheName(source), `${page}-${hash.digest('hex').slice(0, 12)}`);
  });
}
