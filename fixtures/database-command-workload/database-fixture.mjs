// The fixture program behind every declared database command in the real-container tests. It
// stands in for a team's database client, such as psql or a seed script, and prints one JSON value
// on standard output. Its first argument says what it does:
//   echo <arguments…>       prints { "arguments": [...] }, the arguments after "echo", as received;
//   reach <database address> <other service address> <host address>
//                           tries a TCP connection to each address below and prints what each saw:
//                           "reached:<first line the server sent>", "reached" or "blocked";
//   note                    prints { "note": ... }, a note of two lines, for a plan to remember;
//   environment             prints its whole environment.
// The declared database is a container on Docker's default bridge, declared by its address; the
// other addresses are ones a command must never reach: another declared service on the bridge,
// the Docker host (the bridge's gateway, by address and by name), the internet and the metadata
// service.
//
// The tests also run it, outside any workload, as the TCP services the commands try to reach:
//   serve <banner>          listens on port 5432, sends each connection the banner and a line
//                           break, and prints "connection" for each, so the test can count them.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import { connect, createServer } from 'node:net';

const SERVICE_PORT = 5432;

const ATTEMPT_TIMEOUT_MILLISECONDS = 5000;
// Text holding a line break, as a page element or a service field may.
const TWO_LINE_NOTE = 'first line; rm -rf /\nsecond line $(id)';
// The Docker engine's API port, which a command reaching the host could use to take it over.
const DOCKER_API_PORT = 2375;

// Connects, waits briefly for the server's first line, and says what it saw.
function attempt(host, port) {
  return new Promise((resolve) => {
    let settled = false;
    let received = '';
    const socket = connect({ host, port });
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(ATTEMPT_TIMEOUT_MILLISECONDS, () => finish(received === '' ? 'blocked' : `reached:${received}`));
    socket.on('error', () => finish('blocked'));
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      const line = received.split('\n')[0];
      if (received.includes('\n')) finish(`reached:${line}`);
    });
    socket.on('connect', () => setTimeout(() => finish(received === '' ? 'reached' : `reached:${received}`), 2000));
  });
}

async function reach(databaseAddress, otherServiceAddress, hostAddress) {
  const targets = {
    'declared-database': [databaseAddress, SERVICE_PORT],
    'other-service': [otherServiceAddress, SERVICE_PORT],
    'ci-host-by-address': [hostAddress, SERVICE_PORT],
    'ci-host-docker-api': [hostAddress, DOCKER_API_PORT],
    'ci-host-by-name': ['host.docker.internal', SERVICE_PORT],
    'internet-by-name': ['example.com', 443],
    'internet-by-address': ['1.1.1.1', 443],
    'metadata-by-name': ['metadata.google.internal', 80],
    'metadata-by-address': ['169.254.169.254', 80],
  };
  const entries = await Promise.all(Object.entries(targets).map(async ([name, [host, port]]) => [name, await attempt(host, port)]));
  return Object.fromEntries(entries);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'echo') {
  console.log(JSON.stringify({ arguments: rest }));
} else if (mode === 'reach') {
  const [databaseAddress, otherServiceAddress, hostAddress] = rest;
  console.log(JSON.stringify(await reach(databaseAddress, otherServiceAddress, hostAddress)));
} else if (mode === 'note') {
  console.log(JSON.stringify({ note: TWO_LINE_NOTE }));
} else if (mode === 'environment') {
  console.log(JSON.stringify(process.env));
} else if (mode === 'serve') {
  const banner = rest[0] ?? 'service';
  createServer((socket) => {
    console.log('connection');
    socket.on('error', () => undefined);
    socket.write(`${banner}\n`);
  }).listen(SERVICE_PORT, '0.0.0.0', () => console.log('listening'));
} else {
  console.error(`unknown mode: ${String(mode)}`);
  process.exit(2);
}
