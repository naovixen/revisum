// Public entry point: the isolated runner and its egress proxy, the workload runner that runs a
// team's own image behind the same proxy, the resolve-time address check,
// the egress policy builder and how egress events are joined, and the real caller for declared
// service calls, which sends each one through the egress proxy. See docs/specs/SPEC-07-isolated-runner-and-egress.md.
export type { ExecOutcome, ResponseRewrite } from '@revisum/contracts';
export { checkResolvedAddress, type AddressCheckOptions, type AddressVerdict } from './address-check.ts';
export {
  createArguments, dockerCliEngine, runDocker,
  type ContainerEngine, type ContainerMount, type ContainerOptions, type DockerOutcome, type EngineProblem, type ProbeTarget,
} from './container-engine.ts';
export { dockerRunner, type DockerRunnerOptions, type RunnerLogEntry } from './docker-runner.ts';
export { workloadRunner, type WorkloadLogEntry, type WorkloadRunnerOptions } from './workload-runner.ts';
export { noSuchNameAnswer, readDnsQuestion, type DnsQuestion } from './lookup-recorder.ts';
export { hostAndPort, joinEgressEvents } from './egress-events.ts';
export { buildEgressPolicy, type EgressPolicyError, type EgressPolicyInput } from './egress-policy.ts';
export {
  EGRESS_DECISION_HEADER, proxyRules, startEgressProxy, startProxyServer,
  type AddressConnector, type EgressDecisionMark, type AddressResolver, type EgressProxy, type EgressProxyOptions, type ProxyRules, type ProxyServerOptions, type RewriteRule,
} from './egress-proxy.ts';
export { readProxyDecision, readProxyRules } from './proxy-container.ts';
export { RUN_IMAGE_RECORD, RUN_IMAGE_TAG, prepareRunImage, readImageDigest, type RunImage, type RunImageError } from './run-image.ts';
export {
  bodyText, headerFields, serviceCaller, type ServiceCallerOptions, type ServiceCallerTimeouts,
} from './service-caller.ts';
