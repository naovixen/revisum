// Local static server for the accessibility fixtures, on 127.0.0.1 only:
//   /WAI/content-assets/wcag-act-rules/  the pinned W3C ACT test cases, at the paths the cases expect
//   /mapping-pairs/                      fail and clean pages, one pair per seeded WCAG failure
//   /keyboard-pairs/                     fail and clean pages for the keyboard probes
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { FIXTURES } from './repository.ts';

export const ACT_TEST_CASES = join(FIXTURES, 'act-test-cases');
export const ACT_CASE_PREFIX = '/WAI/content-assets/wcag-act-rules/';

const MOUNTS: readonly (readonly [string, string])[] = [
  [ACT_CASE_PREFIX, ACT_TEST_CASES],
  ['/mapping-pairs/', join(FIXTURES, 'mapping-pairs')],
  ['/keyboard-pairs/', join(FIXTURES, 'keyboard-pairs')],
];
const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xhtml': 'application/xhtml+xml', '.svg': 'image/svg+xml',
  '.xml': 'application/xml', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.vtt': 'text/vtt', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json',
};

export type AccessibilityServer = { readonly origin: string; close(): Promise<void> };

export function startAccessibilityServer(): Promise<AccessibilityServer> {
  const server = createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    for (const [prefix, folder] of MOUNTS) {
      if (!requested.startsWith(prefix)) continue;
      const file = resolve(folder, `.${requested.slice(prefix.length - 1)}`);
      if (!file.startsWith(folder) || !existsSync(file) || statSync(file).isDirectory()) break;
      response.writeHead(200, { 'content-type': MEDIA_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(readFileSync(file));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  return new Promise((started) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      started({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
      });
    });
  });
}
