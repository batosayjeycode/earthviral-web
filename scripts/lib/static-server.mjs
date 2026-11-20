/**
 * Minimal static server for QA that mimics Cloudflare Pages behaviour:
 * directory indexes, `/path` -> `/path/` redirects, and dist/404.html with a 404 status.
 * `/api/geo` runs the real Pages Function (functions/api/geo.ts). Without Cloudflare's `cf`
 * object it reads the `CF-IPCountry` request header, which QA sets to test the header's geo swap.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { onRequestGet as geo } from '../../functions/api/geo.ts';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', // Pagefind runtime
};

const isFile = (p) =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

export function serveDist(dir, port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(dir, path);

    if (path === '/api/geo') {
      const country = req.headers['cf-ipcountry'];
      const response = geo({
        request: new Request(url, { headers: country ? { 'CF-IPCountry': String(country) } : {} }),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }

    if (path.endsWith('/')) file = join(file, 'index.html');
    else if (!extname(path) && (await isFile(join(file, 'index.html')))) {
      res.writeHead(308, { Location: `${path}/${url.search}` }).end();
      return;
    }

    if (await isFile(file)) {
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
      return;
    }
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    res.end(await readFile(join(dir, '404.html')));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
