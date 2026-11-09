// The workload container's environment: the variables the request declares, with each secret
// revealed by service-caller.ts, runner's one module that may read one, then Revisum's own, which
// always win.
// Nothing comes from the host's environment: the list starts empty.
import type { Secret, VariableName } from '@revisum/contracts';
import { variableFields } from '../service-calls/ServiceCaller.ts';

// Loopback stays inside the container, so an app the suite starts itself is reached directly.
export const LOOPBACK_HOSTS = 'localhost,127.0.0.1,::1';
// The home folder every workload process gets: the container's private /tmp.
const HOME = { HOME: '/tmp' } as const;

// Revisum's own variables: every process is pointed at the run's proxy, Node's fetch included.
export function proxyVariables(proxyUrl: string): Readonly<Record<string, string>> {
  return {
    ...HOME,
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: LOOPBACK_HOSTS,
    'http_proxy': proxyUrl, 'https_proxy': proxyUrl, 'no_proxy': LOOPBACK_HOSTS,
    // Node's own fetch follows the proxy variables only when told to.
    'NODE_USE_ENV_PROXY': '1',
  };
}

export type CheckedVariable = { readonly name: VariableName; readonly value: string | Secret };

// The whole environment. `httpProxy` false leaves the proxy variables out, for a command that speaks only TCP, such as a
// database client: it reaches its service through the proxy's TCP relay, by the service's name.
export function workloadEnvironment(
  declared: readonly CheckedVariable[], proxyUrl: string, httpProxy = true,
): Readonly<Record<string, string>> {
  const own: Readonly<Record<string, string>> = httpProxy ? proxyVariables(proxyUrl) : HOME;
  // Revisum's own names are refused in either case, so a declared proxy variable never slips in.
  const ownNames = new Set(Object.keys(proxyVariables(proxyUrl)).map((name) => name.toUpperCase()));
  // Entries, not assignment, so a name such as "__proto__" is an ordinary variable.
  return Object.fromEntries([
    ...variableFields(declared.filter((variable) => !ownNames.has(variable.name.toUpperCase()))),
    ...Object.entries(own),
  ]);
}
