export const ProxyStartFailureCode = {
    ListenFailed: "listen-failed",
    RulesRefused: "rules-refused",
} as const;

// Why a proxy did not start. Every listener it opened has been closed by the time this is known.
export type ProxyStartFailure =
    | {
          readonly code: typeof ProxyStartFailureCode.ListenFailed;
          readonly port: number;
          readonly message: string;
      }
    | { readonly code: typeof ProxyStartFailureCode.RulesRefused; readonly message: string };
