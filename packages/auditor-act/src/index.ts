// Public entry point: the own accessibility engine, built from the W3C ACT rules, with
// keyboard and pointer probes. See docs/specs/SPEC-10-accessibility-audit.md.
export * from './accessibility-types.ts';
export { ALL_RULES, scan, type ScanOptions } from './scan.ts';
export { tabWalk, trapSet, type WalkOptions } from './tab-walk.ts';
export { launchBrowser, SCAN_VIEWPORT } from './chromium-page.ts';
export { buildSnapshot, snapshotExtras, type SnapshotExtras } from './page-snapshot.ts';
