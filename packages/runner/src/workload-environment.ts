// The workload container's environment: the variables the request declares, with each secret
// revealed by service-caller.ts, runner's one module that may read one, then Revisum's own, which
// always win.
// Nothing comes from the host's environment: the list starts empty.
// See docs/specs/SPEC-35-evidence-mode.md.
import type { WorkloadVariable } from '@revisum/contracts';
import { variableFields } from './service-caller.ts';

// A name the container's environment can hold as written: no "=", no space, no control character.
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Loopback stays inside the container, so an app the suite starts itself is reached directly.
export const LOOPBACK_HOSTS = 'localhost,127.0.0.1,::1';

// Revisum's own variables: every process is pointed at the run's proxy, Node's fetch included.
export function proxyVariables(proxyUrl: string): Readonly<Record<string, string>> {
  return {
    HOME: '/tmp',
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: LOOPBACK_HOSTS,
    'http_proxy': proxyUrl, 'https_proxy': proxyUrl, 'no_proxy': LOOPBACK_HOSTS,
    // Node's own fetch follows the proxy variables only when told to.
    'NODE_USE_ENV_PROXY': '1',
  };
}

// The whole environment, or null when a declared name could not be written as a variable.
export function workloadEnvironment(declared: readonly WorkloadVariable[], proxyUrl: string): Readonly<Record<string, string>> | null {
  if (!declared.every((variable) => VARIABLE_NAME.test(variable.name))) return null;
  const own = proxyVariables(proxyUrl);
  const ownNames = new Set(Object.keys(own).map((name) => name.toUpperCase()));
  // Entries, not assignment, so a name such as "__proto__" is an ordinary variable.
  return Object.fromEntries([
    ...variableFields(declared.filter((variable) => !ownNames.has(variable.name.toUpperCase()))),
    ...Object.entries(own),
  ]);
}
