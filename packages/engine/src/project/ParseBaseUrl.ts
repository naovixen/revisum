// The base URL a run's relative paths resolve against, parsed once where it enters, so a run never
// meets one it cannot resolve against.
import { failure, success, type BaseUrl, type Origin, type Result } from "@revisum/contracts";
import { brand } from "../foundation/Brand.ts";

export const BaseUrlRefusal = {
    WrongType: "wrong_type",
    InvalidUrl: "invalid_url",
    SchemeNotAllowed: "scheme_not_allowed",
    // A user name or password in the URL would go with every request the page makes.
    CredentialsNotAllowed: "credentials_not_allowed",
} as const;
export type BaseUrlRefusal = (typeof BaseUrlRefusal)[keyof typeof BaseUrlRefusal];

// An absolute http or https URL with no user name or password, kept exactly as written.
export function parseBaseUrl(input: unknown): Result<BaseUrl, BaseUrlRefusal> {
    if (typeof input !== "string") {
        return failure(BaseUrlRefusal.WrongType);
    }
    const url = URL.parse(input);
    if (url === null) {
        return failure(BaseUrlRefusal.InvalidUrl);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return failure(BaseUrlRefusal.SchemeNotAllowed);
    }
    if (url.username !== "" || url.password !== "") {
        return failure(BaseUrlRefusal.CredentialsNotAllowed);
    }
    return success(brand<string, "BaseUrl">(input));
}

// A parsed origin is an http or https URL with no path and no credentials, so it is a base URL as it stands.
export const baseUrlOfOrigin = (origin: Origin): BaseUrl => brand<string, "BaseUrl">(origin);
