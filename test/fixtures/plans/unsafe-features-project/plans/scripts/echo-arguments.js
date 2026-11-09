async function echoArguments(received) {
  // Reports what the script was called with, and the sha256 of its own source text as the page
  // compiled it, so a test can show the source reached the page unchanged. This file holds the
  // function and nothing else, with no line break after it, so its bytes are the source text.
  const sourceBytes = new TextEncoder().encode(echoArguments.toString());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes));
  const sourceSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    report: JSON.stringify({
      callArguments: arguments.length,
      names: Object.keys(received).sort(),
      textType: typeof received.text,
      text: received.text,
      count: received.count,
      flag: received.flag,
      sourceSha256,
    }),
  };
}