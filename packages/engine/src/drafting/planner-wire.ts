// The two request formats a planner endpoint speaks: Anthropic's Messages API and the
// OpenAI-compatible chat completions format. plannerRequestBody writes the fixed request body;
// plannerReplyText decodes a reply, which is outside input, by hand and takes out its text, still
// typed unknown, for parseAiText to bound. A reply that holds no text, such as a tool call, has
// nothing to draft from.
// See docs/specs/SPEC-28-plan-authoring.md and docs/specs/SPEC-37-explore-to-draft.md.
import { failure, success, type PlannerWire, type Result } from '@revisum/contracts';
import type { PlannerPrompt } from './planner-prompt.ts';

// The draft is deterministic as far as the planner allows, and short: a plan is never long.
const TEMPERATURE = 0;
const MAXIMUM_OUTPUT_TOKENS = 4096;
// The longest a planner call may take, and the largest reply read; a longer one fails the call.
export const PLANNER_TIMEOUT_MILLISECONDS = 120_000;
export const MAXIMUM_PLANNER_REPLY_BYTES = 1024 * 1024;
// The Messages API version the Anthropic request is written for, sent in its own header.
export const ANTHROPIC_API_VERSION = '2023-06-01';

// The JSON text of the request body for `wire`. Field names are the APIs' own, so "max_tokens" is
// quoted as written there.
export function plannerRequestBody(wire: PlannerWire, model: string, prompt: PlannerPrompt): string {
  switch (wire) {
    case 'anthropic-messages':
      return JSON.stringify({
        model, 'max_tokens': MAXIMUM_OUTPUT_TOKENS, temperature: TEMPERATURE, system: prompt.instructions,
        messages: [{ role: 'user', content: prompt.message }],
      });
    case 'openai-chat':
      return JSON.stringify({
        model, 'max_tokens': MAXIMUM_OUTPUT_TOKENS, temperature: TEMPERATURE,
        messages: [{ role: 'system', content: prompt.instructions }, { role: 'user', content: prompt.message }],
      });
  }
}

export type PlannerReplyError = { readonly code: 'reply-not-json' | 'no-text' };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The reply's JSON, from the body bytes the planner adapter answered with.
function replyJson(reply: unknown): unknown {
  if (!(reply instanceof Uint8Array)) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply));
  } catch {
    return undefined;
  }
}

// Anthropic: the text of the reply's text blocks. One block is the usual answer; several are
// joined, as the API splits one answer that way. A block whose text is not a string is passed on
// as it is, for parseAiText to refuse.
function anthropicText(json: Readonly<Record<string, unknown>>): unknown {
  const content = json['content'];
  if (!Array.isArray(content)) return undefined;
  const texts: unknown[] = content.filter((block) => isRecord(block) && block['type'] === 'text').map((block) => (isRecord(block) ? block['text'] : undefined));
  if (texts.length === 0) return undefined;
  if (texts.length === 1) return texts[0];
  return texts.every((text) => typeof text === 'string') ? texts.join('') : texts;
}

// OpenAI-compatible: the content of the first choice's message. A tool call leaves it null.
function openAiText(json: Readonly<Record<string, unknown>>): unknown {
  const choices = json['choices'];
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (!isRecord(first)) return undefined;
  const message = first['message'];
  if (!isRecord(message)) return undefined;
  const content = message['content'];
  return content === null ? undefined : content;
}

export function plannerReplyText(wire: PlannerWire, reply: unknown): Result<unknown, PlannerReplyError> {
  const json = replyJson(reply);
  if (!isRecord(json)) return failure({ code: 'reply-not-json' });
  const text = wire === 'anthropic-messages' ? anthropicText(json) : openAiText(json);
  return text === undefined ? failure({ code: 'no-text' }) : success(text);
}
