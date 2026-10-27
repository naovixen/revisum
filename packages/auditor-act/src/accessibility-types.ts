// The accessibility engine's types: outcomes and severities, the page snapshot the rules read,
// the rule shapes, the Tab walk and the findings.
// See docs/specs/SPEC-10-accessibility-audit.md.
import type { Box } from '@revisum/contracts';

// The four W3C ACT outcomes.
export type Outcome = 'passed' | 'failed' | 'inapplicable' | 'cantTell';
export type Severity = 'P1' | 'P2' | 'P3' | 'P4';
export const SEVERITIES: readonly Severity[] = ['P1', 'P2', 'P3', 'P4'];

export interface Browser {
  readonly version: string;
  newPage(): Promise<PageDriver>;
  close(): Promise<void>;
  // True once the launched browser process has exited.
  exited(): boolean;
}

export type PageKey = 'Tab' | 'Escape' | 'Enter';

export interface PageDriver {
  goto(url: string, timeoutMilliseconds?: number): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  pressKey(key: PageKey, shift?: boolean): Promise<void>;
  activeElement(): Promise<{ backendId: number; box: Box | null } | null>;
  // A base64 PNG of a region in page coordinates.
  screenshotClip(clip: Box): Promise<string>;
  // A base64 PNG of the viewport.
  screenshot(): Promise<string>;
  // CSS properties set by author style sheets or the style attribute.
  authorDeclaredProperties(backendId: number): Promise<string[]>;
  // Programmatic focus, for elements a Tab walk cannot reach.
  focusBackend(backendId: number): Promise<boolean>;
  // The darkest and lightest pixels behind a text node, read with the text hidden.
  sampleBackground(textBackendId: number): Promise<{ dark: [number, number, number]; light: [number, number, number] } | null>;
  evaluate<Value>(expression: string): Promise<Value>;
  setViewport(width: number, height: number): Promise<void>;
  close(): Promise<void>;
}

// What the browser's accessibility tree says about an element.
export interface AccessibilityInfo {
  role: string;
  name: string;
  ignored: boolean;
  focusable: boolean;
  properties: Record<string, string | boolean | number>;
}

export interface SnapshotNode {
  index: number;
  backendId: number;
  // DOM nodeType: 1 element, 3 text, 9 document, 11 document fragment.
  nodeType: number;
  // Lower-case nodeName for elements; '#text', '#document' and so on otherwise.
  name: string;
  value: string;
  attributes: Record<string, string>;
  parent: number;
  children: number[];
  // Index of the document the node belongs to, in snapshot order.
  document: number;
  // For the top nodes of a shadow tree, the index of the shadow host; otherwise -1. The snapshot is the flat tree.
  shadowHost: number;
  // The index of the content document if this is a frame element; otherwise -1.
  contentDocument: number;
  style: Record<string, string> | null;
  bounds: Box | null;
  accessibility: AccessibilityInfo | null;
}

export interface PageSnapshot {
  url: string;
  nodes: SnapshotNode[];
  roots: number[];
  viewport: { width: number; height: number };
}

export interface RuleMeta {
  id: string;
  kind: 'act-rule' | 'probe';
  title: string;
  successCriteria: string[];
  source: string;
  severity: Severity;
}

export interface TargetResult {
  node: number;
  outcome: Exclude<Outcome, 'inapplicable'>;
  message: string;
}

export interface StaticRule {
  meta: RuleMeta;
  evaluate(snapshot: PageSnapshot): TargetResult[];
}

export interface TabWalk {
  // Snapshot node indexes in focus order (the first visit of each).
  sequence: number[];
  // The full visit log, including repeats.
  visits: number[];
  // Focus left the page content, back to the document, after the last element.
  endedAtDocument: boolean;
  steps: number;
  // True when focusing the element changed at least one viewport pixel.
  focusVisible: Map<number, boolean>;
  // How much of the focused element was visible at the moment of focus (WCAG 2.4.11).
  obscured: Map<number, { inView: boolean; hits: number; total: number }>;
  // Page-coordinate box at the moment of focus.
  boxes: Map<number, Box>;
  // Viewport-coordinate box at the moment of focus.
  viewportBoxes: Map<number, Box>;
}

export interface InteractiveRule {
  meta: RuleMeta;
  // False for rules that need only the live page (pixels, viewport), not the Tab walk.
  needsWalk: boolean;
  run(page: PageDriver, snapshot: PageSnapshot, walk: TabWalk): Promise<TargetResult[]>;
}

export type Rule = StaticRule | InteractiveRule;

export interface Finding {
  page: string;
  ruleId: string;
  kind: 'act-rule' | 'probe';
  wcag: string[];
  severity: Severity;
  outcome: 'failed' | 'cantTell';
  selector: string[];
  box: Box;
  message: string;
}

export interface RuleRun {
  ruleId: string;
  outcome: Outcome;
  targets: TargetResult[];
}

export interface ScanResult {
  page: string;
  runs: RuleRun[];
  findings: Finding[];
}

export function isStaticRule(rule: Rule): rule is StaticRule {
  return 'evaluate' in rule;
}

// A rule's outcome for the whole page, from the outcomes of its targets.
export function pageOutcome(targets: readonly TargetResult[]): Outcome {
  if (targets.length === 0) return 'inapplicable';
  if (targets.some((target) => target.outcome === 'failed')) return 'failed';
  if (targets.some((target) => target.outcome === 'cantTell')) return 'cantTell';
  return 'passed';
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function isFinding(value: unknown): value is Finding {
  if (typeof value !== 'object' || value === null) return false;
  const finding = value as Record<string, unknown>;
  const box = finding['box'] as Record<string, unknown> | undefined;
  return typeof finding['page'] === 'string'
    && typeof finding['ruleId'] === 'string' && finding['ruleId'] !== ''
    && (finding['kind'] === 'act-rule' || finding['kind'] === 'probe')
    && Array.isArray(finding['wcag']) && finding['wcag'].length > 0
    && finding['wcag'].every((criterion) => typeof criterion === 'string' && /^\d\.\d\.\d{1,2}$/.test(criterion))
    && SEVERITIES.includes(finding['severity'] as Severity)
    && (finding['outcome'] === 'failed' || finding['outcome'] === 'cantTell')
    && Array.isArray(finding['selector']) && finding['selector'].length > 0
    && finding['selector'].every((selector) => typeof selector === 'string' && selector !== '')
    && typeof box === 'object' && box !== null
    && isFiniteNumber(box['x']) && isFiniteNumber(box['y']) && isFiniteNumber(box['width']) && isFiniteNumber(box['height'])
    && (box['width'] as number) >= 0 && (box['height'] as number) >= 0
    && typeof finding['message'] === 'string';
}
