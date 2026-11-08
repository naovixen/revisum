// Public entry point: the isolated runner and its egress proxy, the workload runner that runs a
// team's own image behind the same proxy, the resolve-time address check,
// the egress policy builder and how egress events are joined, and the real caller for declared
// service calls, which sends each one through the egress proxy.
export type { ExecOutcome, ResponseRewrite } from '@revisum/contracts';
export { checkResolvedAddress, type AddressCheckOptions, type AddressVerdict } from './address-check.ts';
export {
  createArguments, dockerCliEngine, runDocker,
  type ContainerEngine, type ContainerMount, type ContainerOptions, type DockerOutcome, type EngineProblem, type ImageAnswer, type NetworkFailure, type ProbeTarget,
} from './container-engine.ts';
export { dockerRunner, type DockerRunnerOptions, type RunnerLogEntry } from './docker-runner.ts';
export { readVariableName } from './ReadVariableName.ts';
export type { VariableName } from '@revisum/contracts';
export { workloadRunner, type WorkloadLogEntry, type WorkloadRunnerOptions } from './workload/WorkloadRunner.ts';
export { noSuchNameAnswer, readDnsQuestion, type DnsQuestion } from './lookup-recorder.ts';
export { hostAndPort } from '@revisum/contracts';
export { joinEgressEvents } from './egress-events.ts';
export { buildEgressPolicy, type EgressPolicyError, type EgressPolicyInput } from './egress-policy.ts';
export type { AddressConnector } from './egress-proxy/AddressConnector.ts';
export type { AddressResolver } from './egress-proxy/AddressResolver.ts';
export { EGRESS_DECISION_HEADER, type EgressDecisionMark } from './egress-proxy/EgressDecisionHeader.ts';
export type { EgressProxy } from './egress-proxy/EgressProxy.ts';
export { parseProxyRules, proxyRules, readProxyRules } from './egress-proxy/ParseProxyRules.ts';
export type { ProxyRulesRefusal, ProxyRulesRefusalCode } from './egress-proxy/ProxyRulesRefusal.ts';
export { ProxyClient } from './egress-proxy/ProxyClient.ts';
export type { ProxyCloseFailure } from './egress-proxy/ProxyListeners.ts';
export type { ConnectionFailure, ListenerFailure } from './egress-proxy/ProxyRecord.ts';
export type { ParsedRewriteRule, ProxyRules, RewriteRule } from './egress-proxy/ProxyRules.ts';
export type { ProxyStartFailure } from './egress-proxy/ProxyStartFailure.ts';
export { startEgressProxy, type EgressProxyOptions } from './egress-proxy/StartEgressProxy.ts';
export { startProxyServer, type ProxyServerOptions } from './egress-proxy/StartProxyServer.ts';
export { readBrowserRefusals } from './ReadBrowserRefusals.ts';
export { readProxyDecision } from './proxy-container.ts';
export { RUN_IMAGE_RECORD, RUN_IMAGE_TAG, prepareRunImage, readImageDigest, type RunImage, type RunImageError } from './run-image.ts';
export {
  bodyText, headerFields, serviceCaller, type ServiceCallerOptions, type ServiceCallerTimeouts,
} from './service-caller.ts';
