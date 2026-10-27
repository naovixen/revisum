// Compile-time guarantees of the report generator. Type-checked by test/proofs/type-check.test.ts
// and never run: each @ts-expect-error line must stay an error.
import { PRODUCT } from '@revisum/contracts';
import { generate, type History, type ReportInput } from '@revisum/report';

declare const history: History;
declare const unvalidated: ReportInput;
declare const assets: { readonly png: ReadonlyMap<string, Uint8Array> };

// @ts-expect-error a ReportInput that did not come from parseReportInput is not accepted
generate(unvalidated, assets, history);
// @ts-expect-error unknown data cannot be rendered
generate(JSON.parse('{}') as unknown, assets, history);
// @ts-expect-error a plain object literal cannot be rendered
generate({ schema: `${PRODUCT.schemaNamespace}.report-input/v1` as const }, assets, history);
