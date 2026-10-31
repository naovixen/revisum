// Decodes what a page script returned. The driver hands back the result written as JSON text in
// the page; that text is outside data, written by code the team declared but Revisum cannot
// judge, so it is decoded here by hand under limits the page cannot change:
//   - more than the script's maximumResultBytes (as UTF-8) is script-result-too-large, refused
//     before anything is parsed;
//   - lists and objects nested deeper than 64 are script-result-invalid, found by a scan of the
//     text before it is parsed, so a deep value never reaches the parser;
//   - text that is not JSON is script-result-invalid.
// The caller then reads only the declared fields, by JSON pointer. The text itself is never kept:
// the run records its sha256.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import { failure, success, type Result } from '@revisum/contracts';

// How deeply a script's result may nest lists and objects.
export const MAXIMUM_SCRIPT_RESULT_DEPTH = 64;

export type ScriptResultErrorCode = 'script-result-too-large' | 'script-result-invalid';

// The deepest nesting of lists and objects in JSON text, counting only brackets outside strings.
// It stops counting once past `limit`, so a long run of brackets costs no more than the limit.
function nestingDepth(text: string, limit: number): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      // A backslash escapes the next character, a quote among them.
      if (character === '\\') index++;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[' || character === '{') {
      depth++;
      if (depth > deepest) deepest = depth;
      if (deepest > limit) return deepest;
    } else if (character === ']' || character === '}') depth--;
  }
  return deepest;
}

// The script's result as a JSON value, or why it is refused.
export function decodeScriptResult(text: string, maximumResultBytes: number): Result<unknown, ScriptResultErrorCode> {
  if (Buffer.byteLength(text, 'utf8') > maximumResultBytes) return failure('script-result-too-large');
  if (nestingDepth(text, MAXIMUM_SCRIPT_RESULT_DEPTH) > MAXIMUM_SCRIPT_RESULT_DEPTH) return failure('script-result-invalid');
  try {
    return success(JSON.parse(text));
  } catch {
    return failure('script-result-invalid');
  }
}
