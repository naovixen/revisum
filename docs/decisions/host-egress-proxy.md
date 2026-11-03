# Host runs go through the egress proxy

## In short

- Every browser session on a host run goes through its own egress proxy, with WebRTC UDP off. Host runs stay labelled `host` and claim nothing new.
- The proxy can't be forgotten: `cdpDriver` requires an `egress` source that only `cli` fills, so leaving it out fails to compile.
- Founder's decision, 2026-11-03, on proofs in `test/proofs/BrowserEgressWithoutProxy.test.ts`, `BrowserLeavingThePage.test.ts` and `BrowserBackgroundTraffic.test.ts`. Defect rows 39, 47, 49 and 141 to 146.

## Decisions

| Decision | Why |
|---|---|
| `driver-cdp/src/SessionEgress.ts`: `type SessionEgress = { readonly proxy: ProxySettings; refusedOrigins(): readonly string[]; close(): Promise<void> }` and `type EgressSource = (allowedOrigins: readonly string[]) => Promise<SessionEgress>` | `driver-cdp` may not import `runner`, so `cli` hands it the source |
| `CdpDriverOptions.egress: EgressSource` is required, `proxy?` goes, and `LaunchSettings.proxy` is required | A driver with no proxy can't be built |
| `cli/src/BuildAdapters.ts` is the composition root: `buildAdapters.hostBrowserDriver({ executablePath, fixturesFolder?, proxyPort? })` and `buildAdapters.containerBrowserDriver({ executablePath, proxyServer })`, with options added as the steps below need them. A lint proof lets only this file in `packages/` import `cdpDriver` | One place to wire, and no way round it |
| `open` checks the engine, starts the egress, then launches. `close` settles popups, closes the browser and context, then closes the egress in a `finally`. A failed start returns `launch-failed` | The allow-list first exists at `open`, and proxy rules are fixed at start |
| The host source calls `startProxyServer({ allowedOrigins, privateOrigins: allowedOrigins, rewrites: [] }, ...)` with `includeLoopback: true` | Without `privateOrigins` a declared `127.0.0.1` is refused. Without `includeLoopback`, loopback addresses are expected to go direct |
| Declared origins may reach private addresses, and metadata addresses are refused (founder) | Internal staging and localhost keep working. A declared name that changes to a private address mid-run stays possible, a known gap on host runs |
| Shared test browsers: test support reserves one port per file and starts each session's proxy on it through `ProxyServerOptions.port` | `whyRefused` compares proxy strings. A changeable allow-list would put a test seam in security code |
| `details.blockedOrigins` merges `browser.blocked` with `egress.refusedOrigins()`, preferring the browser's form when `hostAndPort` matches. `hostAndPort` moves to `contracts` | So `https://x` and `x:443` can't both appear |
| `ProxyServerOptions.client: 'service' \| 'browser'`, a table checked with `satisfies Record`. For `browser`, a dead declared origin closes the socket instead of answering 502, and there's no 30 s idle limit | A rendered 502 would lose `navigation-failed` |
| `proxyFlags` sends both `--webrtc-ip-handling-policy` and `--force-webrtc-ip-handling-policy` as `disable_non_proxied_udp`, so a proxy always brings them | The pinned Chrome holds only the first spelling. The headless shell holds both |
| A STUN attempt has no entry in `blockedOrigins` (founder): the proofs keep "sends nothing" and drop that one assertion for STUN | With UDP off, no datagram is sent, so nothing can be refused. Wrapping `RTCPeerConnection` would let a hostile page forge evidence |
| Popups: the step still fails at once. `#closePopup` adds its `firstRequest` promise (at most 1 s) to a set that `close` awaits first. `onPopupRequest` records a refusal when `isAllowedRequest(url)` says no | The run's read of blocked origins is complete after close, with no race |
| Chrome's own traffic is stopped at the source by flags and prefs, each earning its place against `BrowserBackgroundTraffic`, one at a time. No host filter | Otherwise Chrome's attempts land in `blockedOrigins`, and a filter would hide service-worker traffic too |
| `explore-in-container.ts` refuses to run with no `HTTP_PROXY` | Today it silently runs with no proxy |

Commit order:

1. Code, no behaviour change: `BuildAdapters.ts`, still proxy-less, with both callers moved.
2. Tests, red: repoint the proofs, rename `BrowserEgressWithoutProxy` to `BrowserEgressOnHostRuns`, and add `client: 'browser'`, merge, lint and port-reuse tests and a WebTransport channel.
3. Code: Chrome's own traffic. It goes first, or those attempts land in `blockedOrigins`.
4. Code: held popups and the popup race.
5. Code: `egress` beside `proxy?`, with the merge, the proxy client table, the WebRTC flags and the corrected comment.
6. Tests: repoint test support and container tests.
7. Code: delete `proxy?` and make `egress` required.
8. Tests: `@ts-expect-error` in `compile-time-guarantees.ts`.
9. Docs: mark the defect rows.

## Findings

- Checked by reading or grep, with no browser run: the code paths, the counts below and the golden facts. The WebRTC spellings were confirmed in the pinned 156 binaries.
- Direct `cdpDriver(` calls: 10 in 6 test-set files and 2 in `packages/`. 22 files import `CreateBrowserDriver`, about 76 test files use a browser harness, and 37 call `shareBrowserInThisFile()`.
- No golden is expected to change: none names `blockedOrigins`, and the replay manifest holds no flags. A replay hash change means Chrome's traffic is still leaking in, so fix that rather than record again. Don't bump `CDP_ADAPTER_VERSION`.
- Expected cost is under 1% of browser test time. That's an estimate, so measure it.

## Risks

- **Chrome's traffic may not reach zero.** No flag is proven, nothing has a good candidate for `update.googleapis.com`, and it may change with each browser pin. If it can't reach zero, the founder decides. Try in this order: `--disable-field-trial-config`, `--allow-browser-signin=false` or the pref `signin.allowed: false`, `--disable-component-extensions-with-background-pages`, then the feature behind `/async/folae`.
- **`--disable-field-trial-config` may change rendering,** so run `check:linux`.
- **Assumed, not run:** every flag's effect, Chromium's loopback bypass, TURN through the proxy, WebTransport failing closed, and unknown switches being ignored.
- **Windows:** rebinding one port may fail, which the port-reuse test covers. `connection: close` per request adds TIME_WAIT sockets.
- **Moving about 76 test files at step 6 may expose more.** Fix causes and loosen no assertions.
- **A declared name that fails DNS now shows as blocked.**
