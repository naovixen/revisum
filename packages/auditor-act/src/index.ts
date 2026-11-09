// Public entry point: the own accessibility engine, built from the W3C ACT rules, with
// keyboard and pointer probes.
export * from './rules/Rule.ts';
export { ACT_RULESET_VERSION, ALL_RULES, scan, type ScanOptions } from './scan/Scan.ts';
export { tabWalk, trapSet, type WalkOptions } from './scan/TabWalk.ts';
export { launchBrowser, SCAN_VIEWPORT } from './page/LaunchBrowser.ts';
export { buildSnapshot, snapshotExtras, type SnapshotExtras } from './page/BuildSnapshot.ts';
