// In-process server for one fixture app. It serves a fixed file list from memory and nothing else.
// A test may watch the paths the page asks for, such as a file a fixture page fetches to say it
// has reached a given point.
// A test may also give routes: paths the server answers with a response the test builds, such as
// a file download with a chosen Content-Disposition, a body streamed in chunks, or a page that
// shows a cookie the browser sent. A route takes precedence over a file of the same path.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { sha256, type FixtureReference } from '@revisum/engine';

const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
};

// What a route answers. `chunks` sends the body in pieces with a pause between them and no
// Content-Length, so the browser cannot know the size before the bytes arrive.
export type FixtureResponse = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
  readonly chunks?: readonly Buffer[];
  readonly chunkPauseMilliseconds?: number;
};
// The request as a route sees it: its path, its query and the Cookie header it carried.
export type FixtureRequest = { readonly path: string; readonly query: URLSearchParams; readonly cookie: string };
export type FixtureRoute = (request: FixtureRequest) => FixtureResponse;

export type FixtureServer = { readonly origin: string; readonly fixtures: readonly FixtureReference[]; close(): Promise<void> };

export async function startFixtureServer(
  folder: string, onRequest?: (path: string) => void, routes: ReadonlyMap<string, FixtureRoute> = new Map(),
): Promise<FixtureServer> {
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(folder)) files.set(`/${name}`, readFileSync(join(folder, name)));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const requested = url.pathname;
    const path = requested === '/' ? '/index.html' : requested;
    onRequest?.(path);
    const route = routes.get(path);
    if (route !== undefined) {
      const answer = route({ path, query: url.searchParams, cookie: request.headers.cookie ?? '' });
      response.writeHead(answer.status ?? 200, { 'cache-control': 'no-store', ...answer.headers });
      const chunks = answer.chunks;
      if (chunks === undefined) { response.end(answer.body ?? ''); return; }
      let next = 0;
      const sendNext = (): void => {
        if (response.destroyed) return;
        const chunk = chunks[next];
        next += 1;
        if (chunk === undefined) { response.end(); return; }
        response.write(chunk);
        setTimeout(sendNext, answer.chunkPauseMilliseconds ?? 0);
      };
      sendNext();
      return;
    }
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
