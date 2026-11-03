# Host runs go through a per-session egress proxy

## In short

- Every browser session on a host run has its own egress proxy, set on the browser context, with WebRTC UDP off. Chrome's own traffic goes to a dead browser-wide proxy, so it can't reach the session's proxy or leave the machine.
- Host runs stay labelled `host` and claim nothing new. Undeclared origins are refused and shown.
- The proxy can't be forgotten: `cdpDriver` requires an `egress` source that only `cli` fills, so leaving it out fails to compile.
- Founder's rulings, 2026-11-03, after research on every network block and a trial of the per-context proxy. They replace the earlier flag-by-flag design. Defect rows 39, 47, 49 and 141 to 146.

## Decisions

| Decision | Why |
|---|---|
| `driver-cdp/src/SessionEgress.ts`: `type SessionEgress = { readonly proxy: ProxySettings; refusedOrigins(): readonly string[]; close(): Promise<void> }` and `type EgressSource = (allowedOrigins: readonly string[]) => Promise<SessionEgress>` | `driver-cdp` may not import `runner`, so `cli` hands it the source |
| `CdpDriverOptions.egress: EgressSource` is required, and `proxy?` goes | A driver with no proxy can't be built |
| `open` parses the proxy value with `parseProxyServer`, the only maker of the `ProxyServer` brand, and an empty one fails the session | In the trial, an empty `proxyServer` created the context without error and everything went direct, even with a browser-wide proxy up, in 20 of 20 runs |
| `cli/src/BuildAdapters.ts` is the composition root: `buildAdapters.hostBrowserDriver({ executablePath, fixturesFolder? })` and `buildAdapters.containerBrowserDriver({ executablePath, proxyServer })`, with options added as the steps below need them. A lint proof lets only this file in `packages/` import `cdpDriver` | One place to wire, and no way round it |
| `open` checks the engine, starts the egress, then calls `Target.createBrowserContext({ proxyServer, proxyBypassList: '<-loopback>' })`. `close` settles popups, closes the browser and context, then closes the egress in a `finally`. A failed start returns `launch-failed` | The allow-list first exists at `open`. Without `<-loopback>`, pages reach loopback and link-local addresses directly |
| Launch adds a dead browser-wide proxy, `--disable-features=AimEnabled` and both WebRTC flags | Chrome's own traffic reaches only the dead proxy. `AimEnabled` stops the one request that creating a context otherwise sends through the session's proxy, `GET www.google.com/async/folae` |
| Every launch sends both `--webrtc-ip-handling-policy` and `--force-webrtc-ip-handling-policy` as `disable_non_proxied_udp`, the audit browser's too | Chrome honours only the first and the headless shell only the second. Together they gave 0 datagrams |
| Undeclared origins are refused and shown (founder) | "Stayed on the declared list" would otherwise be false. The report points at refusals, so a missing CDN is a clear fix |
| Metadata: refuse all of `169.254.0.0/16` and `fe80::/10`, plus `168.63.129.16` and `fd20:ce::254`, for every origin (founder) | The exact-address list let ECS, EKS, GCP and Azure addresses through. An app on a link-local address is refused, which should be very rare |
| Declared origins may reach private addresses, and each name's address class is fixed at its first lookup (founder) | Internal staging and localhost keep working, and a name changing from public to private mid-run is refused and recorded. A name that really moves mid-run is refused too |
| `localhost` and `*.localhost` are loopback with no lookup, and the proxy tries each vetted address in turn | Declared `localhost` with an app on `127.0.0.1` answered 502 on Windows, because `::1` resolves first and only `addresses[0]` was tried. `*.localhost` failed lookup |
| `ProxyServerOptions.client: 'service' \| 'browser'`, a table checked with `satisfies Record`. For `browser`, a refusal or dead declared origin closes the socket instead of answering, and there's no idle limit. A service's idle limit is 130 s, above the caller's longest call of 120 s, so the caller's own timeout decides | A page in a worker or out-of-process frame could read a 403 as content, and a rendered 502 would lose `navigation-failed` |
| `EgressProxy.connectionFailures()` returns `{ origin, message }`, once per origin, and `SessionEgress` carries it in step 6 so a run can show it. It's a diagnostic, kept out of the hashed result | The corporate proxy error: nothing reliably tells a machine proxy from a dead origin, so the message covers both, and loopback gets only "nothing answered". It isn't in a service's answer, because isolated containers run this code too |
| A DNS failure is not `blocked` | A name that doesn't resolve wasn't refused |
| A name with both public and private addresses is refused if any address is refused, and a private name that gains a public address is refused | The class is fixed per name, and a mix can't be fitted to one |
| The host source passes every allowed origin as `privateOrigins`, and a proxy with none stays strict | Only host runs allow declared private addresses, so isolated runs' rule doesn't change |
| `blockedOrigins` means "refused and seen", not "every attempt" (founder). Reword `browser-driver.ts`. The report says WebRTC and WebTransport are off | WebRTC UDP, WebTransport and cross-site prefetch never reach a proxy. Wrapping page APIs would let a hostile page forge evidence |
| Proofs keep "sends nothing" for those three, with controls showing they do send with no proxy, and drop the entry assertion | Nothing is sent, so nothing can be refused |
| `blockedOrigins` stays in the hash (founder). Measure replay stability once the host proxy is in; if hashes vary, fix the cause, and take it to the founder if that can't be done | Edits to the evidence stay detectable |
| `details.blockedOrigins` merges `browser.blocked` with `egress.refusedOrigins()`, preferring the browser's form when `hostAndPort` matches. `hostAndPort` moves to `contracts` | So `https://x` and `x:443` can't both appear |
| Popups: the step still fails at once. `#closePopup` adds its `firstRequest` promise (at most 1 s) to a set that `close` awaits first. A popup is added to `blocked` only when undeclared | The run's read of blocked origins is complete after close, with no race |
| Corporate proxies are deferred (founder): a host run that can't connect out gives a clear error saying a machine proxy isn't supported yet | `egress-proxy.ts` connects directly on purpose, and there's no customer behind one yet |
| `explore-in-container.ts` refuses to run with no `HTTP_PROXY` | Today it silently runs with no proxy |
| Kept unchanged (founder): the plan gate, isolated runs' proxy and no-route network, the Fetch allow-list as a second layer, private ranges for undeclared names, loopback through the proxy, workers seen by the proxy and not blanket-blocked, downloads refused without a download step, and service calls with proxy settings stripped | See the table below |

Commit order (step 1 is `e2b4f89`):

2. Tests, red: repoint and rename the proofs to `BrowserEgressOnHostRuns`, and add localhost dual-stack, `*.localhost`, refusal closes the socket, DNS failure not blocked, link-local, first-seen class, empty proxy value, two sessions in one browser, a WebTransport channel, `client: 'browser'`, merge and lint tests. The background proof asserts the session proxy hears nothing.
3. Code, proxy: the `client` table, each vetted address in turn, `localhost` with no lookup, refusal closes the socket, DNS failure not blocked, and the corporate proxy error.
4. Code, `address-check.ts`: wider metadata refusal and first-seen class.
5. Code: held popups and the popup race.
6. Code: `egress` beside `proxy?`, the context proxy, the dead browser-wide proxy, `AimEnabled` off, the WebRTC flags and the merge.
7. Tests: repoint test support, with no port per file, and add a mix of public and private addresses on a name's first lookup, which only a script has checked so far.
8. Code: delete `proxy?` and the proxy check in `whyRefused`, and make `egress` required. Then measure replay stability.
9. Tests: `@ts-expect-error` in `compile-time-guarantees.ts`.
10. Code: `explore-in-container` refuses with no `HTTP_PROXY`, the audit launch gets the WebRTC flags, the report names the channels that are off, and a run shows `connectionFailures()`, which step 7 makes required.
11. Docs: the defect rows, then `check:linux` and `check:containers`.

## Findings

Each row says what the block stops, then what dropping it would do, then what others do. Sources were fetched by a research helper, some through page summaries.

| Block | If dropped | Others |
|---|---|---|
| Undeclared origins on host | WebSocket, out-of-process frames, workers, speculation and TURN reach any address, and the run shows nothing | [Smokescreen](https://github.com/stripe/smokescreen) enforces or reports. [Sauce](https://docs.saucelabs.com/dev/cli/sauce-connect-5/run/) and [BrowserStack](https://www.browserstack.com/local-testing/tunnel-firewall) have tunnel rules, with no default-deny found. [Playwright](https://playwright.dev/docs/network) documents none |
| Chrome's own traffic | Refusals of traffic the page never made vary with run length, and on host real calls reach Google | [Playwright #42910](https://github.com/microsoft/playwright/issues/42910) says no flag stops two of the hosts, and it [sets the proxy on the context](https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/crBrowser.ts) |
| Metadata addresses | A page reads a cloud runner's credentials | [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), [ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html), [GCP](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata), [Azure](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16) |
| Private ranges and rebinding | An attacker's DNS points a declared name into the customer's network mid-run | OWASP, and Smokescreen is default-deny |
| WebRTC UDP | UDP leaves unseen, even with the proxy down | [Chromium's policy flag](https://codereview.chromium.org/1315223002/) only |
| Loopback through the proxy | Pages reach loopback directly, and 169.254 skips the proxy | [Chromium's implicit bypass](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md), which Playwright also overrides |
| Popups held | A popup loads unsupervised | Playwright routes at context level |
| Service and shared workers | The proxy is the only witness, so they show as `unattributed` | [Playwright can block service workers](https://playwright.dev/docs/network). Apps use them, so we don't |
| Plan gate | A plan hits production | [Cypress has an optional deny-list](https://docs.cypress.io/app/references/configuration); no norm in browser tools |
| Isolated proxy and no-route network | `isolated` becomes false | [harden-runner](https://github.com/step-security/harden-runner) at host level |

Trial of the per-context proxy, on Chrome 156.0.8078.47 for Windows with the repo's flags and raw CDP, not the driver:

- 70 runs on both builds: no page host reached the browser-wide proxy. Page fetch, WebSocket, frames, all three workers, same-origin prefetch and TURN over TCP reached the context proxy. Two contexts each used their own proxy with no cross-talk.
- About 220 failure runs across 11 modes (proxy down, answering 403, resetting, killed mid-run, bad config and others): nothing reached a witness or the browser-wide proxy, and controls showed the witnesses work. The one exception is the empty `proxyServer` above.
- Chrome's Google traffic went only to the browser-wide proxy. The headless shell sent none. The context still loads pages with that proxy refusing everything or on a closed port.
- `AimEnabled` off gave 0 requests before the page's own in 15 of 15 runs. `PreconnectToSearch` off still gave 1 in every run, so the research's attribution of that request was wrong, and that flag isn't needed.
- `proxyServer` is [documented](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-createBrowserContext) and marked experimental; the method itself isn't.

## Risks

- **The experimental field may change at a browser pin.** If it goes, everything hits the dead proxy, so it fails loudly. The background proof catches a change at each pin.
- **`AimEnabled` may be renamed at a pin.** The same proof would catch it.
- **Unproven:** the per-context proxy on Linux, through the real driver across a whole suite, with downloads and stubs; browser test time; IPv6 in containers. Steps 7 and 11 test these. If one fails, fix the cause and loosen no assertions.
- **Late requests may flip the hash.** Measured after step 8.
- **The dead proxy.** A closed loopback port could be bound by another program, which would then receive Chrome's traffic. So the driver holds the port itself, with a listener that closes every connection, for as long as the browser runs.
- **UDP was checked with witnesses and the page's ICE candidates,** not a packet capture. A reachability check to `[2001:4860:4860::8888]:443` appears in the network log; assumed to send nothing, not captured.
- **Isolated browsers still get answered refusals.** `proxy-container.ts` leaves `client` at `service`, so a page in a container could read a 403 as content, the same reason host runs close the socket. Defect 157 covers this; the fix needs the container tests.
