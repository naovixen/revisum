// In-process server for one fixture app. It serves a fixed file list from memory and nothing else.
// A test may watch the paths the page asks for, such as a file a fixture page fetches to say it
// has reached a given point.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { sha256, type FixtureReference } from '@revisum/engine';

const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
};

export type FixtureServer = { readonly origin: string; readonly fixtures: readonly FixtureReference[]; close(): Promise<void> };

export async function startFixtureServer(folder: string, onRequest?: (path: string) => void): Promise<FixtureServer> {
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(folder)) files.set(`/${name}`, readFileSync(join(folder, name)));
  const server = createServer((request, response) => {
    const requested = new URL(request.url ?? '/', 'http://localhost').pathname;
    const path = requested === '/' ? '/index.html' : requested;
    onRequest?.(path);
    const body = files.get(path);
    if (body === undefined) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': MEDIA_TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    fixtures: [...files].map(([path, body]) => ({ path, sha256: sha256(body) })),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
