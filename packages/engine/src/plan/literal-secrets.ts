// A plan never holds a secret: it names one with { secretName }. The plan parser rejects two kinds
// of literal secret with literal_secret, giving the path but never the text:
//   - literal text filled into a field whose locator names a sensitive field, such as a password,
//     passcode, token, secret or API key, in English, German or French;
//   - text anywhere in the plan shaped like a credential: a JSON Web Token, a "Bearer" header
//     value, or a key with a well-known issuer prefix.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import type { Locator } from '@revisum/contracts';

// Words that name a field holding a credential.
const SENSITIVE_FIELD_WORDS: readonly RegExp[] = [
  // English
  /pass(?:word|code|phrase)/i, /\btokens?\b/i, /\bsecrets?\b/i, /\bapi[\s_-]?keys?\b/i, /\bprivate[\s_-]?keys?\b/i,
  // German: Passwort, Kennwort, Geheimnis, Geheimcode, Zugangsschlüssel, API-Schlüssel
  /passwort/i, /kennwort/i, /\bgeheim/i, /zugangs?schl[üu]ssel/i, /\bapi[\s_-]?schl[üu]ssel/i,
  // French: mot de passe, code secret, jeton, clé API, clé d'API
  /mot\s+de\s+passe/i, /\bjetons?\b/i, /\bcl[ée]s?\s+(?:d['’]\s*)?api\b/i, /\bcl[ée]\s+secr[èe]te/i,
];

// Text shaped like a credential. Each pattern needs enough characters after its marker that
// ordinary prose, such as "task-list" or "risk-free", never matches.
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  // A JSON Web Token: three base64url parts, the first an encoded JSON header ("eyJ").
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  // GitHub tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // OpenAI, Anthropic and Stripe style secret keys
  /\bsk-[A-Za-z0-9_-]{20,}/, /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  // AWS access key ids
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  // Slack, GitLab and Google API keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bglpat-[A-Za-z0-9_-]{20,}/, /\bAIza[A-Za-z0-9_-]{35}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const looksLikeCredential = (text: string): boolean => CREDENTIAL_SHAPES.some((shape) => shape.test(text));

// The text a locator finds its element by.
function locatorText(locator: Locator): string {
  switch (locator.by) {
    case 'role': return locator.name;
    case 'label': return locator.label;
    case 'text': return locator.text;
    case 'testId': return locator.testId;
  }
}

export const namesSensitiveField = (locator: Locator): boolean =>
  SENSITIVE_FIELD_WORDS.some((word) => word.test(locatorText(locator)));
