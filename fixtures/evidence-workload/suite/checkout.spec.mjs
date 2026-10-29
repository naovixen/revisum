// The fixture suite the Playwright Test stand-in runs in the workload container. One test passes;
// the other receives the declared secret SHOP_API_TOKEN and, as a careless or hostile test might,
// writes it to standard output and standard error and puts it in its error message, raw and in
// the encoded forms a leak can take. Revisum must keep none of them.
// See docs/specs/SPEC-35-evidence-mode.md.
export const describe = 'Checkout';

// Text the error message keeps around the secret, so a test can see the message reached the result.
export const MESSAGE_TEXT = 'sign-in refused for token';

const echoes = (token) => [
  token,
  encodeURIComponent(token),
  Buffer.from(token).toString('base64'),
  Buffer.from(token).toString('base64url'),
  token.slice(0, 20),
  token.toUpperCase(),
].join(' ');

export const tests = [
  {
    title: 'shows the order total',
    annotations: [{ type: 'criterion', description: 'checkout.order-total' }],
    run: async () => {},
  },
  {
    title: 'signs in with the shop token',
    run: async ({ environment }) => {
      const token = environment.SHOP_API_TOKEN ?? '';
      console.log(`signing in with ${echoes(token)}`);
      console.error(`retrying with ${echoes(token)}`);
      throw new Error(`${MESSAGE_TEXT} ${echoes(token)}`);
    },
  },
];
