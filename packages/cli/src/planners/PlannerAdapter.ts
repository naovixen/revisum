// The planner adapters behind the draft command, one per wire format: Anthropic Messages and the
// OpenAI-compatible chat format, which local servers such as Ollama also speak. Each sends the
// engine's fixed request body to the endpoint's address through runner's service caller, so the
// egress proxy decides where the call may go and only runner's caller ever reveals the key.
//
// The key, the customer's own, travels as an opaque secret in its wire format's header alone:
// x-api-key (as it is) for Anthropic, "Authorization: Bearer" for the OpenAI-compatible format. A
// local endpoint may have none. A failed call answers with its code alone, never the planner's
// reply, which may echo the key.
import {
  ANTHROPIC_API_VERSION, MAXIMUM_PLANNER_REPLY_BYTES, PLANNER_TIMEOUT_MILLISECONDS, failure, headerSecret, plannerPrompt, plannerRequestBody, success,
  type DraftPlanner, type DraftRequest, HeaderScheme, type PlannerEndpoint, PlannerWire, type Result, type SecretStore,
  type ServiceCallErrorCode, type ServiceCaller, type ServiceRequestHeader,
} from '@revisum/engine';
import { HttpMethod } from '@revisum/contracts';

// Why a planner call failed: the service caller's code, or a status other than success.
export type PlannerCallFailure = ServiceCallErrorCode | 'planner-status';

// A draft planner whose answer is the reply as received, or the code that says why there is none. A
// programming error is not a failed call, so it rejects.
export interface PlannerAdapter extends DraftPlanner {
  draft(request: DraftRequest): Promise<Result<Uint8Array, PlannerCallFailure>>;
}

// The header each wire format carries the key in, and how.
const KEY_HEADERS: { readonly [Wire in PlannerWire]: { readonly name: string; readonly scheme: HeaderScheme } } = {
  'anthropic-messages': { name: 'x-api-key', scheme: HeaderScheme.Raw },
  'openai-chat': { name: 'authorization', scheme: HeaderScheme.Bearer },
};

const JSON_MEDIA_TYPE = 'application/json';

export type PlannerConnection = {
  readonly caller: ServiceCaller;
  readonly secrets: SecretStore;
};

// The adapter for the endpoint's wire format, or secret-missing when its key's secret is not in
// the store. Requests go to the endpoint's origin, the one the egress proxy allows.
export function plannerAdapter(endpoint: PlannerEndpoint, connection: PlannerConnection): Result<PlannerAdapter, 'secret-missing'> {
  const headers: ServiceRequestHeader[] = [];
  if (endpoint.apiKey !== undefined) {
    const secret = connection.secrets.resolve(endpoint.apiKey.secretName);
    if (secret === null) return failure('secret-missing');
    const keyHeader = KEY_HEADERS[endpoint.wire];
    headers.push({ name: keyHeader.name, value: headerSecret(secret, keyHeader.scheme) });
  }
  if (endpoint.wire === PlannerWire.AnthropicMessages) headers.push({ name: 'anthropic-version', value: ANTHROPIC_API_VERSION });
  headers.push({ name: 'content-type', value: JSON_MEDIA_TYPE });
  const { origin, pathAndQuery } = endpoint;
  return success({
    async draft(request: DraftRequest): Promise<Result<Uint8Array, PlannerCallFailure>> {
      const body = plannerRequestBody(endpoint.wire, endpoint.model, plannerPrompt(request));
      const answered = await connection.caller.call({
        origin, method: HttpMethod.Post, pathAndQuery, headers, body: { jsonParts: [body] },
        timeoutMilliseconds: PLANNER_TIMEOUT_MILLISECONDS, maximumResponseBytes: MAXIMUM_PLANNER_REPLY_BYTES,
      });
      if (!answered.ok) return failure(answered.error);
      // The caller reads one byte past the cap and leaves whoever set it to refuse a body that long.
      if (answered.value.body.length > MAXIMUM_PLANNER_REPLY_BYTES) {
        return failure('response-too-large');
      }
      if (answered.value.status < 200 || answered.value.status > 299) return failure('planner-status');
      // The reply as received, for the engine to decode.
      return success(answered.value.body);
    },
  });
}
