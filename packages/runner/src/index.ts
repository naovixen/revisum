// Public entry point: the isolated runner and its egress proxy, the workload runner that runs a
// team's own image behind the same proxy, the resolve-time address check,
// the egress policy builder and how egress events are joined, and the real caller for declared
// service calls, which sends each one through the egress proxy.
export type { ExecOutcome, ResponseRewrite } from '@revisum/contracts';
export { checkResolvedAddress, type AddressCheckOptions, type AddressVerdict } from './egress/CheckResolvedAddress.ts';
export {
  createArguments, dockerCliEngine, runDocker,
  type ContainerEngine, type ContainerMount, type ContainerOptions, type DockerOutcome, type EngineProblem, type ImageAnswer, type NetworkFailure, type ProbeTarget,
} from './containers/ContainerEngine.ts';
export { dockerRunner, type DockerRunnerOptions, type RunnerLogEntry } from './containers/DockerRunner.ts';
export { readVariableName } from './containers/ReadVariableName.ts';
export type { VariableName } from '@revisum/contracts';
export { workloadRunner, type WorkloadLogEntry, type WorkloadRunnerOptions } from './workload/WorkloadRunner.ts';
export { noSuchNameAnswer, readDnsQuestion, type DnsQuestion } from './egress/StartLookupRecorder.ts';
export { hostAndPort } from '@revisum/contracts';
export { joinEgressEvents } from './egress/JoinEgressEvents.ts';
export { buildEgressPolicy, type EgressPolicyError, type EgressPolicyInput } from './egress/BuildEgressPolicy.ts';
export type { AddressConnector } from './egress-proxy/addresses/AddressConnector.ts';
export type { AddressResolver } from './egress-proxy/addresses/AddressResolver.ts';
export { EGRESS_DECISION_HEADER, type EgressDecisionMark } from './egress-proxy/requests/EgressDecisionHeader.ts';
export type { EgressProxy } from './egress-proxy/EgressProxy.ts';
export { parseProxyRules, proxyRules, readProxyRules } from './egress-proxy/rules/ParseProxyRules.ts';
export type { ProxyRulesRefusal, ProxyRulesRefusalCode } from './egress-proxy/rules/ProxyRulesRefusal.ts';
export { ProxyClient } from './egress-proxy/ProxyClient.ts';
export type { ProxyCloseFailure } from './egress-proxy/ProxyListeners.ts';
export type { ConnectionFailure, ListenerFailure } from './egress-proxy/ProxyRecord.ts';
export type { ParsedRewriteRule, ProxyRules, RewriteRule } from './egress-proxy/rules/ProxyRules.ts';
export type { ProxyStartFailure } from './egress-proxy/ProxyStartFailure.ts';
export { startEgressProxy, type EgressProxyOptions } from './egress-proxy/StartEgressProxy.ts';
export { startProxyServer, type ProxyServerOptions } from './egress-proxy/StartProxyServer.ts';
export { readBrowserRefusals } from './egress/ReadBrowserRefusals.ts';
export { readProxyDecision } from './egress/StartRecordKeeping.ts';
export { NO_IMAGE, RUN_IMAGE_RECORD, RUN_IMAGE_TAG, prepareRunImage, readImageDigest, type RunImage, type RunImageError } from './image/RunImage.ts';
export {
  bodyText, headerFields, serviceCaller, type ServiceCallerOptions, type ServiceCallerTimeouts,
} from './service-calls/ServiceCaller.ts';
