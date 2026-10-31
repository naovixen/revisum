// The planner adapters behind the draft command, one per wire format: Anthropic Messages and the
// OpenAI-compatible chat format, which local servers such as Ollama also speak. Each sends the
// engine's fixed request body to the endpoint's address through runner's service caller, so the
// egress proxy decides where the call may go and only runner's caller ever reveals the key.
//
// The key, the customer's own, travels as an opaque secret in its wire format's header alone:
// x-api-key (as it is) for Anthropic, "Authorization: Bearer" for the OpenAI-compatible format. A
// local endpoint may have none. A failed call rejects with its code alone, never the planner's
// reply, which may echo the key.
// See docs/specs/SPEC-28-plan-authoring.md and docs/specs/SPEC-37-explore-to-draft.md.
import {
  ANTHROPIC_API_VERSION, MAXIMUM_PLANNER_REPLY_BYTES, PLANNER_TIMEOUT_MILLISECONDS, failure, headerSecret, plannerPrompt, plannerRequestBody, success,
  type DraftPlanner, type DraftRequest, type HeaderScheme, type Origin, type PlannerEndpoint, type PlannerWire, type Result, type SecretStore,
  type ServiceCallErrorCode, type ServiceCaller, type ServiceRequestHeader,
} from '@revisum/engine';

// Why a planner call failed: the service caller's code, or a status other than success.
export type PlannerCallFailure = ServiceCallErrorCode | 'planner-status';

// What a planner adapter rejects with. Its message is fixed and it carries only the code, so
// nothing the planner sent can travel with it.
export class PlannerCallError extends Error {
  readonly code: PlannerCallFailure;

  constructor(code: PlannerCallFailure) {
    super('the planner call failed');
    this.name = 'PlannerCallError';
    this.code = code;
  }
}

// The header each wire format carries the key in, and how.
const KEY_HEADERS: { readonly [Wire in PlannerWire]: { readonly name: string; readonly scheme: HeaderScheme } } = {
  'anthropic-messages': { name: 'x-api-key', scheme: 'raw' },
  'openai-chat': { name: 'authorization', scheme: 'bearer' },
};

const JSON_MEDIA_TYPE = 'application/json';

export type PlannerConnection = {
  readonly caller: ServiceCaller;
  readonly secrets: SecretStore;
};

// True when a local endpoint's host is on the loopback interface: an IPv4 address in 127.0.0.0/8,
// the IPv6 loopback address, or the name localhost.
export function isLoopbackEndpoint(endpoint: PlannerEndpoint): boolean {
  let hostname: string;
  try {
    hostname = new URL(endpoint.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

// The adapter for the endpoint's wire format, or secret-missing when its key's secret is not in
// the store. `origin` is the endpoint's origin, as the egress proxy allows it.
export function plannerAdapter(endpoint: PlannerEndpoint, origin: Origin, connection: PlannerConnection): Result<DraftPlanner, 'secret-missing'> {
  const headers: ServiceRequestHeader[] = [];
  if (endpoint.apiKey !== undefined) {
    const secret = connection.secrets.resolve(endpoint.apiKey.secretName);
    if (secret === null) return failure('secret-missing');
    const keyHeader = KEY_HEADERS[endpoint.wire];
    headers.push({ name: keyHeader.name, value: headerSecret(secret, keyHeader.scheme) });
  }
  if (endpoint.wire === 'anthropic-messages') headers.push({ name: 'anthropic-version', value: ANTHROPIC_API_VERSION });
  headers.push({ name: 'content-type', value: JSON_MEDIA_TYPE });
  // The endpoint's url is the full address the request is posted to; the project parser has
  // already checked it is one.
  const address = new URL(endpoint.url);
  const pathAndQuery = `${address.pathname}${address.search}`;
  return success({
    async draft(request: DraftRequest): Promise<unknown> {
      const body = plannerRequestBody(endpoint.wire, endpoint.model, plannerPrompt(request));
      const answered = await connection.caller.call({
        origin, method: 'POST', pathAndQuery, headers, body: { jsonParts: [body] },
        timeoutMilliseconds: PLANNER_TIMEOUT_MILLISECONDS, maximumResponseBytes: MAXIMUM_PLANNER_REPLY_BYTES,
      });
      if (!answered.ok) throw new PlannerCallError(answered.error);
      if (answered.value.status < 200 || answered.value.status > 299) throw new PlannerCallError('planner-status');
      // The reply as received, for the engine to decode.
      return answered.value.body;
    },
  });
}
