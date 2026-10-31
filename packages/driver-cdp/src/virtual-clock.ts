// The own driver's clock port: one virtual time for the whole session. The determinism kit's
// advance controller runs in each frame's main world, where the page's timers are, so an advance
// fires them there; the driver only tells each frame how far to go.
//   - Each page of the session (the first tab and any newTab) registers here. When the plan
//     advances the clock, its pages' timers run on virtual time from their first document on.
//   - An advance moves the session's time first and re-registers the new-document script at the new
//     time, so a document that loads during or after the advance starts there and page time never
//     goes backwards. Then every frame is advanced to that time in turn: tab by tab in the order
//     they opened, the top document first, then its frames in document order.
//   - The callbacks every frame fires count against one limit; past it the advance fails with
//     clock-runaway. Nothing here waits for real time.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import {
  CLOCK_CONTROLLER_KEY, failure, success, virtualClockScript,
  type ClockAdvanceMode, type ClockPort, type DriverError, type Result,
} from '@revisum/contracts';
import { advanceDocumentClock } from './in-page.ts';
import type { PageCommand } from './web-storage.ts';

type FrameTree = { readonly frame: { readonly id: string }; readonly childFrames?: readonly FrameTree[] };
type CallResult = { readonly result: { readonly value?: unknown; readonly objectId?: string }; readonly exceptionDetails?: { readonly text: string } };
type DescribedNode = { readonly node: { readonly contentDocument?: { readonly backendNodeId: number } } };

// One page of the session, as the clock reaches it.
type ClockPage = {
  readonly command: PageCommand;
  readonly crashed: () => boolean;
  // The identifier of the page's new-document script that starts virtual timers, when registered.
  scriptIdentifier: string | null;
};

// What one frame's controller reported.
type FrameAdvance = { readonly fired: number; readonly runaway: boolean };

const CRASHED: DriverError = { code: 'target-crashed', detail: 'the page\'s renderer died during the clock advance' };

// Decodes the controller's answer; anything else counts as a frame that fired nothing.
function frameAdvance(value: unknown): FrameAdvance {
  if (typeof value !== 'object' || value === null) return { fired: 0, runaway: false };
  const fired: unknown = Reflect.get(value, 'fired');
  const runaway: unknown = Reflect.get(value, 'runaway');
  return { fired: typeof fired === 'number' && Number.isInteger(fired) && fired >= 0 ? fired : 0, runaway: runaway === true };
}

// Every frame id of a page, top document first, then each frame before its own frames.
function frameIds(tree: FrameTree): string[] {
  return [tree.frame.id, ...(tree.childFrames ?? []).flatMap(frameIds)];
}

export class BrowserClock implements ClockPort {
  readonly #virtualTimers: boolean;
  readonly #pages: ClockPage[] = [];
  // Milliseconds the run has advanced its clock since the frozen start.
  #elapsed = 0;

  // With virtualTimers false the plan never advances the clock, so its pages keep real-time timers.
  constructor(virtualTimers: boolean) {
    this.#virtualTimers = virtualTimers;
  }

  // Registers a page before it loads anything; gives the function that forgets it once it closes.
  async watchPage(command: PageCommand, crashed: () => boolean): Promise<() => void> {
    const page: ClockPage = { command, crashed, scriptIdentifier: null };
    if (this.#virtualTimers) await this.#startAt(page, this.#elapsed);
    this.#pages.push(page);
    return () => {
      const index = this.#pages.indexOf(page);
      if (index >= 0) this.#pages.splice(index, 1);
    };
  }

  async advance(milliseconds: number, mode: ClockAdvanceMode, maximumTimers: number): Promise<Result<void, DriverError>> {
    if (!Number.isInteger(milliseconds) || milliseconds < 1) return failure({ code: 'unsupported-step', detail: 'an advance is a whole number of milliseconds, at least 1' });
    const target = this.#elapsed + milliseconds;
    this.#elapsed = target;
    let fired = 0;
    for (const page of [...this.#pages]) {
      if (page.crashed()) return failure(CRASHED);
      try {
        if (this.#virtualTimers) await this.#startAt(page, target);
        const { frameTree } = await page.command<{ frameTree: FrameTree }>('Page.getFrameTree');
        for (const frameId of frameIds(frameTree)) {
          const advanced = await this.#advanceFrame(page, frameId, frameId === frameTree.frame.id, target, mode, maximumTimers - fired);
          fired += advanced.fired;
          if (advanced.runaway) {
            return failure({ code: 'clock-runaway', detail: `the advance would fire more than ${maximumTimers} timer callbacks` });
          }
        }
      } catch (error) {
        if (page.crashed()) return failure(CRASHED);
        throw error;
      }
    }
    return success(undefined);
  }

  // Replaces the page's new-document script with one that starts virtual timers at `elapsed`.
  async #startAt(page: ClockPage, elapsed: number): Promise<void> {
    if (page.scriptIdentifier !== null) {
      await page.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.scriptIdentifier });
      page.scriptIdentifier = null;
    }
    const added = await page.command<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source: virtualClockScript(elapsed) });
    page.scriptIdentifier = added.identifier;
  }

  // Runs one frame's controller in its main world. A frame whose document went away meanwhile
  // fires nothing here: the document that replaced it started at the new time.
  async #advanceFrame(
    page: ClockPage, frameId: string, top: boolean, target: number, mode: ClockAdvanceMode, maximumCallbacks: number,
  ): Promise<FrameAdvance> {
    try {
      const documentObject = top ? await this.#topDocument(page) : await this.#frameDocument(page, frameId);
      if (documentObject === null) return { fired: 0, runaway: false };
      const called = await page.command<CallResult>('Runtime.callFunctionOn', {
        functionDeclaration: advanceDocumentClock.toString(), objectId: documentObject, awaitPromise: true, returnByValue: true,
        arguments: [{ value: CLOCK_CONTROLLER_KEY }, { value: target }, { value: mode }, { value: maximumCallbacks }],
      });
      if (called.exceptionDetails !== undefined) return { fired: 0, runaway: false };
      return frameAdvance(called.result.value);
    } catch (error) {
      if (page.crashed()) throw error;
      return { fired: 0, runaway: false };
    }
  }

  // The top document, in the page's main world.
  async #topDocument(page: ClockPage): Promise<string | null> {
    const evaluated = await page.command<CallResult>('Runtime.evaluate', { expression: 'document' });
    return evaluated.result.objectId ?? null;
  }

  // An iframe's document, resolved in its own main world, which is where DOM.resolveNode puts a node
  // when no world is named.
  async #frameDocument(page: ClockPage, frameId: string): Promise<string | null> {
    const owner = await page.command<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId });
    const described = await page.command<DescribedNode>('DOM.describeNode', { backendNodeId: owner.backendNodeId, depth: 1, pierce: true });
    const contentDocument = described.node.contentDocument;
    if (contentDocument === undefined) return null;
    const resolved = await page.command<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: contentDocument.backendNodeId });
    return resolved.object.objectId ?? null;
  }
}
