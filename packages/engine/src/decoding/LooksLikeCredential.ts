// A plan never holds a secret: it names one with { secretName }. The plan parser rejects two kinds
// of literal secret with literal_secret, giving the path but never the text:
//   - literal text filled into a field whose locator names a sensitive field, such as a password,
//     passcode, token, secret or API key, in English, German or French;
//   - text anywhere in the plan shaped like a credential: a JSON Web Token, a "Bearer" or "Basic"
//     header value, a url holding a user name and password, or a key with a well-known issuer prefix.
import {
    StructuralLocatorKind,
    SemanticLocatorKind,
    literalText,
    type Locator,
} from "@revisum/contracts";

// Words that name a field holding a credential.
const SENSITIVE_FIELD_WORDS: readonly RegExp[] = [
    // English. "pass" may stand apart from the rest once a code-style name is split ("passWord").
    // Sites also abbreviate these names, number them or run their words together ("clientsecret"),
    // so a word boundary alone would miss them; "#tokenizer" and "#author" must still not match.
    /pass\s?(?:word|code|phrase|wd)/i,
    /\bpwd\d*\b/i,
    /\b(?:auth|access|refresh|session|api|id|csrf|xsrf)?tokens?\d*\b/i,
    /\b(?:client|app|api|shared)?secrets?\d*\b/i,
    /\bapi[\s_-]?keys?\d*\b/i,
    /\bprivate[\s_-]?keys?\b/i,
    // German: Passwort, Kennwort, Geheimnis, Geheimcode, Zugangsschlüssel, API-Schlüssel
    /pass\s?wort/i,
    /kenn\s?wort/i,
    /\bgeheim/i,
    /zugangs?schl[üu]ssel/i,
    /\bapi[\s_-]?schl[üu]ssel/i,
    // French: mot de passe, code secret, jeton, clé API, clé d'API
    /mot\s*de\s*passe/i,
    /\bjetons?\b/i,
    /\bcl[ée]s?\s+(?:d['’]\s*)?api\b/i,
    /\bcl[ée]\s+secr[èe]te/i,
];

// Text shaped like a credential. Each pattern needs enough characters after its marker that
// ordinary prose, such as "task-list" or "risk-free", never matches.
const CREDENTIAL_SHAPES: readonly RegExp[] = [
    // A JSON Web Token: three base64url parts, the first an encoded JSON header ("eyJ").
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
    /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
    // GitHub tokens
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    // OpenAI, Anthropic and Stripe style secret keys
    /\bsk-[A-Za-z0-9_-]{20,}/,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
    // AWS access key ids
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    // Slack, GitLab and Google API keys
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /\bglpat-[A-Za-z0-9_-]{20,}/,
    /\bAIza[A-Za-z0-9_-]{35}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    // A url holding a user name and a password. A port is followed by "/", not "@", so it passes.
    /:\/\/[^\s/?#:@]+:[^\s/?#@]+@/,
];

const BASIC_HEADER_VALUE = /\bbasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi;
const PRINTABLE_ASCII_WITH_A_COLON = /^[\x20-\x7e]*:[\x20-\x7e]*$/;

// "Basic" is an ordinary word and may be followed by a long one, so the value has to decode to the
// "user:password" text such a header holds. Prose read as base64 does not decode to printable text.
const holdsBasicCredentials = (text: string): boolean =>
    [...text.matchAll(BASIC_HEADER_VALUE)].some(
        ([, encoded = ""]) =>
            encoded.length % 4 === 0 &&
            PRINTABLE_ASCII_WITH_A_COLON.test(Buffer.from(encoded, "base64").toString("latin1")),
    );

export const looksLikeCredential = (text: string): boolean =>
    CREDENTIAL_SHAPES.some((shape) => shape.test(text)) || holdsBasicCredentials(text);

// The text a locator finds its element by, as the plan writes it: a value reference has no text
// until the run, so it names no field here. A css selector or XPath expression names a field by
// its structure, such as input[type=password], so its own text is judged, with any hasText, and
// with the locator it is inside, which may name the field just as plainly.
function locatorText(locator: Locator): string {
    switch (locator.by) {
        case SemanticLocatorKind.Role:
            return literalText(locator.name) ?? "";
        case SemanticLocatorKind.Label:
            return literalText(locator.label) ?? "";
        case SemanticLocatorKind.Text:
            return literalText(locator.text) ?? "";
        case SemanticLocatorKind.TestId:
            return literalText(locator.testId) ?? "";
        case StructuralLocatorKind.Css:
            return [locator.selector, ...surroundingText(locator)].join(" ");
        case StructuralLocatorKind.Xpath:
            return [locator.expression, ...surroundingText(locator)].join(" ");
    }
}

function surroundingText(locator: Extract<Locator, { by: "css" | "xpath" }>): readonly string[] {
    return [
        locator.hasText === undefined ? "" : (literalText(locator.hasText) ?? ""),
        locator.inside === undefined ? "" : locatorText(locator.inside),
    ];
}

// Splits names written in code style into words, so a test id or selector such as "authToken",
// "client_secret" or "#access-token" names its field as a label would: "auth Token",
// "client secret", "#access token". Underscores count as word characters, so without this the
// word patterns above would never see "secret" in "client_secret".
const separateCodeWords = (text: string): string =>
    text
        .replace(/(\p{Ll}|\p{Nd})(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
        .replace(/[_-]+/g, " ");

export const namesSensitiveField = (locator: Locator): boolean => {
    const text = separateCodeWords(locatorText(locator));
    return SENSITIVE_FIELD_WORDS.some((word) => word.test(text));
};
