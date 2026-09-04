import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * Static file server for a built site directory. Returns an unstarted http.Server.
 * @param {string} root directory to serve, defaults to ./dist
 */
export function createStaticServer(root = resolve('dist')) {
  root = resolve(root);
  return createServer(async (req, res) => {
    try {
      let path = join(root, decodeURIComponent(req.url.split('?')[0]));
      if (!path.startsWith(root)) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      let s = await stat(path).catch(() => null);
      if (s?.isDirectory()) {
        path = join(path, 'index.html');
        s = await stat(path).catch(() => null);
      }
      if (!s) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
      res.end(await readFile(path));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT) || 8080;
  createStaticServer().listen(port, () => console.log(`http://localhost:${port}`));
}
