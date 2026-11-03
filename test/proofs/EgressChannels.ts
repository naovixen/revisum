// The ways a page can try to reach an address, each written as a page that tries once and then, after
// long enough for the attempt to land, says so. Each channel names what the address records when
// the attempt gets through, so the same page can show both that it arrives and that it does not.
import {
    Arrival,
    framePath,
    requestArrival,
    websocketArrival,
    type RecordingOrigin,
} from "./StartRecordingOrigin.ts";

export const ATTEMPT_STATE = "attempt-state";
export const ATTEMPT_SETTLED = "Settled";
export const SETTLE_MILLISECONDS = 2_000;

export type ChannelAddress = Pick<RecordingOrigin, "origin" | "hostname" | "port" | "datagramPort">;

// What a channel's page is built from.
export type ChannelPageInputs = {
    // The address the page tries.
    readonly address: ChannelAddress;
    // A declared origin on another site, so a frame it serves runs out of process.
    readonly frameHostOrigin: string;
    readonly workerScriptPath: string;
};

export type EgressChannel = {
    // Where the channel's pages are served, as one path segment.
    readonly name: string;
    // Finishes the sentence "a page that".
    readonly attempt: string;
    // What the address records when the attempt gets through.
    readonly arrival: string;
    page(inputs: ChannelPageInputs): string;
    workerScript?(address: ChannelAddress): string;
};

const inlineScript = (source: string): string => `<script>${source}</script>`;

// Starts gathering candidates, which is what makes a peer connection contact its ICE servers.
const peerConnectionTo = (server: Readonly<Record<string, string>>): string =>
    inlineScript(`
      const connection = new RTCPeerConnection({ iceServers: [${JSON.stringify(server)}] });
      connection.createDataChannel("probe");
      connection.createOffer().then((offer) => connection.setLocalDescription(offer));`);

const WORKER_FILE_PATH = "/from-worker";
const SPECULATED_PATH = "/speculated";

// A worker the page starts, which asks the address for a file as soon as it runs.
const workerStartedBy = (
    start: (scriptPath: string) => string,
): Pick<EgressChannel, "arrival" | "page" | "workerScript"> => ({
    arrival: requestArrival(WORKER_FILE_PATH),
    page: ({ workerScriptPath }) => inlineScript(start(JSON.stringify(workerScriptPath))),
    workerScript: ({ origin }) =>
        `fetch(${JSON.stringify(`${origin}${WORKER_FILE_PATH}`)}, { mode: "no-cors" });`,
});

// The channels a declared address may still use on a host run.
export const REQUEST_CHANNELS: readonly EgressChannel[] = [
    {
        name: "websocket",
        attempt: "opens a WebSocket",
        arrival: websocketArrival("/socket"),
        page: ({ address: { hostname, port } }) =>
            inlineScript(`new WebSocket(${JSON.stringify(`ws://${hostname}:${port}/socket`)});`),
    },
    {
        name: "frame-load",
        attempt: "loads a frame from another site",
        arrival: requestArrival(framePath()),
        page: ({ address: { origin } }) =>
            `<iframe title="Frame" src="${origin}${framePath()}"></iframe>`,
    },
    {
        name: "out-of-process-frame",
        attempt: "holds a frame of a declared site that fetches a file",
        arrival: requestArrival("/from-frame"),
        page: ({ address: { origin }, frameHostOrigin }) =>
            `<iframe title="Frame" src="${frameHostOrigin}${framePath(`${origin}/from-frame`)}"></iframe>`,
    },
    {
        name: "dedicated-worker",
        attempt: "starts a dedicated worker that fetches a file",
        ...workerStartedBy((scriptPath) => `new Worker(${scriptPath});`),
    },
    {
        name: "service-worker",
        attempt: "registers a service worker that fetches a file",
        ...workerStartedBy((scriptPath) => `navigator.serviceWorker.register(${scriptPath});`),
    },
    {
        name: "shared-worker",
        attempt: "starts a shared worker that fetches a file",
        ...workerStartedBy((scriptPath) => `new SharedWorker(${scriptPath});`),
    },
    {
        name: "speculation-rules",
        attempt: "asks for a prefetch through speculation rules",
        arrival: requestArrival(SPECULATED_PATH),
        page: ({ address: { origin } }) =>
            `<script type="speculationrules">${JSON.stringify({
                prefetch: [{ source: "list", urls: [`${origin}${SPECULATED_PATH}`] }],
            })}</script>`,
    },
];

// Off on a host run whatever the address, so a declared address cannot show that these pages send.
export const WEBRTC_CHANNELS: readonly EgressChannel[] = [
    {
        name: "webrtc-stun",
        attempt: "gathers WebRTC candidates from a STUN server",
        arrival: Arrival.Datagram,
        page: ({ address: { hostname, datagramPort } }) =>
            peerConnectionTo({ urls: `stun:${hostname}:${datagramPort}` }),
    },
    {
        name: "webrtc-turn",
        attempt: "gathers WebRTC candidates from a TURN server over TCP",
        arrival: Arrival.Connection,
        page: ({ address: { hostname, port } }) =>
            peerConnectionTo({
                urls: `turn:${hostname}:${port}?transport=tcp`,
                username: "probe",
                credential: "probe",
            }),
    },
];

export const EGRESS_CHANNELS: readonly EgressChannel[] = [...REQUEST_CHANNELS, ...WEBRTC_CHANNELS];

export const preconnectTo = ({ origin }: ChannelAddress): string =>
    `<link rel="preconnect" href="${origin}">`;

export const dnsPrefetchOf = (name: string): string =>
    `<link rel="dns-prefetch" href="http://${name}">`;

export const attemptPage = (attempt: string): string => `<!doctype html><html lang="en">
  <head><meta charset="utf-8"><title>Attempt</title></head>
  <body><main>
    <p data-testid="${ATTEMPT_STATE}">Attempting</p>
    ${attempt}
    <script>
      setTimeout(() => {
        document.querySelector('[data-testid="${ATTEMPT_STATE}"]').textContent = "${ATTEMPT_SETTLED}";
      }, ${SETTLE_MILLISECONDS});
    </script>
  </main></body></html>`;
