// Runs inside the run container, started in the background by explore-isolated.test.ts; it is not
// a test file of its own. It serves the Lantern Books fixture site (the same site the host-mode
// tests crawl) on the container's own loopback, at fixed ports, since the start URL is given to
// the draft command before the container exists. The browser inside reaches loopback without the
// egress proxy, which would refuse any private address. Each request either server answers is
// appended as one JSON line to REQUESTS_FILE, in the container's private /tmp, for the test to read.
// See docs/specs/SPEC-37-explore-to-draft.md.
import { appendFileSync } from 'node:fs';
import { startExploreSite } from '../unit/cli/explore-command-examples.ts';

export const INSIDE_SITE_PORT = 4380;
export const INSIDE_SECOND_PORT = 4381;
export const INSIDE_SITE_ORIGIN = `http://127.0.0.1:${INSIDE_SITE_PORT}`;
export const INSIDE_SECOND_ORIGIN = `http://127.0.0.1:${INSIDE_SECOND_PORT}`;
export const REQUESTS_FILE = '/tmp/explore-site-requests.jsonl';
export const SITE_MODULE = 'test/containers/explore-site-inside.ts';

async function main(): Promise<void> {
  // The servers keep the process alive until the container is removed.
  await startExploreSite({
    sitePort: INSIDE_SITE_PORT,
    secondPort: INSIDE_SECOND_PORT,
    onRequest: (server, path) => appendFileSync(REQUESTS_FILE, `${JSON.stringify({ server, path })}\n`),
  });
}

if (import.meta.main) await main();
