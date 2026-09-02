import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const root = resolve('dist');
const port = Number(process.env.PORT) || 8080;
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

createServer(async (req, res) => {
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
}).listen(port, () => console.log(`http://localhost:${port}`));
