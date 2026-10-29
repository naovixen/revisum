// In-process server for fixtures/egress-app. It serves the folder's files from memory, and one
// route more: /leave answers with a redirect to an undeclared origin, so a page can make the
// browser follow a redirect out of its declared origins.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { sha256, type FixtureReference } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';

export const EGRESS_APP = join(FIXTURES, 'egress-app');
export const REDIRECT_TARGET = 'http://redirect.invalid/landing';

const MEDIA_TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

export type EgressFixtureServer = {
  readonly origin: string;
  readonly fixtures: readonly FixtureReference[];
  // Every path a client asked for, in order.
  readonly requested: readonly string[];
  url(path: string): string;
  close(): Promise<void>;
};

export async function startEgressFixtureServer(): Promise<EgressFixtureServer> {
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(EGRESS_APP)) files.set(`/${name}`, readFileSync(join(EGRESS_APP, name)));
  const requested: string[] = [];
  const server = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? '/', 'http://localhost').pathname;
    requested.push(path);
    if (path === '/leave') { response.writeHead(302, { location: REDIRECT_TARGET, 'cache-control': 'no-store' }).end(); return; }
    const body = files.get(path === '/' ? '/index.html' : path);
    if (body === undefined) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': MEDIA_TYPES[extname(path)] ?? 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const serverOrigin = `http://127.0.0.1:${port}`;
  return {
    origin: serverOrigin,
    fixtures: [...files].map(([path, body]) => ({ path, sha256: sha256(body) })),
    requested,
    url: (path) => `${serverOrigin}${path}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
