// A driver that needs no browser and whose page behaves like a real one for the checks the secret
// tests make: a field keeps what a fill typed into it, so a later check observes that value, and
// an element found by its test id shows a text the test chooses, such as a careless echo of a
// secret. The test hands in the values of the secrets it planted, so the driver never needs
// reveal: it looks the typed value up by the secret's name, as a real page would hold it.
import { performableLocator, success, type BrowserDriver, type ElementProbe, type Locator } from '@revisum/engine';
import { ORIGIN } from './secret-examples.ts';
import { performableAction, READ_FAILED } from '#test-support/fakes/FakePage.ts';
import { fakeSession } from '#test-support/fakes/FakeSession.ts';
import { fakeDriverOpening } from '#test-support/fakes/FakeDriver.ts';

export type EchoPage = {
  // Texts shown by elements found by test id, keyed by the test id.
  readonly texts?: Readonly<Record<string, string>>;
  // The value each planted secret holds, keyed by the secret's name.
  readonly secretValues?: Readonly<Record<string, string>>;
};

export type EchoPageCalls = { navigations: number; actions: number; probes: number };

// Fields are found by their label, shown texts by their test id; anything else is a key of its own.
function elementKey(locator: Locator): string {
  if (locator.by === 'label' && typeof locator.label === 'string') return `label:${locator.label}`;
  if (locator.by === 'testId' && typeof locator.testId === 'string') return `testId:${locator.testId}`;
  return JSON.stringify(locator);
}

export function echoPageDriver(page: EchoPage): BrowserDriver & { readonly calls: EchoPageCalls; readonly fieldValues: ReadonlyMap<string, string> } {
  const calls: EchoPageCalls = { navigations: 0, actions: 0, probes: 0 };
  const fieldValues = new Map<string, string>();
  const shown = (text: string, value: string | null): ElementProbe => ({ count: 1, visible: true, enabled: true, text, value, sensitive: false, box: null });
  const session = fakeSession({
    browser: { name: 'echo-page-browser', version: '1.0' },
    navigate: () => { calls.navigations++; return Promise.resolve(success(undefined)); },
    page: () => Promise.resolve({ url: `${ORIGIN}/`, title: 'Echo page', meta: [], canonicalUrl: null }),
    act: (step, _guard, secret) => {
      calls.actions++;
      // What any driver refuses comes before the page: it keeps no value of a step it would not perform.
      if (step.type !== 'dialog') {
        const performable = performableAction(step, secret);
        if (!performable.ok) {
          return Promise.resolve(performable);
        }
      }
      if (step.type === 'fill') {
        const plainText = typeof step.value === 'string' ? step.value : '';
        const typed = secret === undefined ? plainText : page.secretValues?.[secret.name] ?? '';
        fieldValues.set(elementKey(step.locator), typed);
      }
      return Promise.resolve(success(undefined));
    },
    probe: (locator) => {
      calls.probes++;
      if (performableLocator(locator) === undefined) {
        return Promise.resolve(READ_FAILED);
      }
      const key = elementKey(locator);
      const typed = fieldValues.get(key);
      if (typed !== undefined) return Promise.resolve(shown('', typed));
      const text = locator.by === 'testId' && typeof locator.testId === 'string' ? page.texts?.[locator.testId] : undefined;
      return Promise.resolve(text === undefined ? { count: 0, visible: false, enabled: false, text: '', value: null, sensitive: false, box: null } : shown(text, null));
    },
  });
  return {
    ...fakeDriverOpening(session, { info: { id: 'fake', version: 'echo-page', protocol: 'none' } }),
    calls,
    fieldValues,
  };
}

// ---- An independent check for a secret hidden in kept text ----------------------------------------

// Every reading of `text` a person could decode a secret from: as written, form- and
// percent-decoded (either hex case), and each run of base64 or base64url characters decoded from
// each of its four possible starting points.
function decodedReadings(text: string): string[] {
  const readings = [text];
  for (const decode of [(raw: string) => decodeURIComponent(raw.replace(/\+/g, ' ')), decodeURIComponent]) {
    try { readings.push(decode(text)); } catch { /* not valid percent-encoding: nothing to read */ }
  }
  for (const run of text.match(/[A-Za-z0-9+/_-]{4,}/g) ?? []) {
    for (let start = 0; start < 4; start++) {
      const part = run.slice(start);
      readings.push(Buffer.from(part, 'base64').toString('latin1'), Buffer.from(part, 'base64url').toString('latin1'));
    }
  }
  return readings;
}

// True when `text` still holds `value` in any case, as typed or encoded in a form a reader could decode.
export const holdsSecret = (text: string, value: string): boolean =>
  decodedReadings(text).some((reading) => reading.toLowerCase().includes(value.toLowerCase()));
