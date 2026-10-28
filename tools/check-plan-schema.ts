// Keeps the plan language's published JSON Schema true. It fails, naming the file, when:
//   - docs/plan-language/plan.schema.json is not exactly what the engine's planJsonSchema() builds;
//   - a golden plan in golden/plans/ does not validate against the schema;
//   - the newest entry in docs/plan-language/CHANGELOG.md does not name the schema file's sha256,
//     so the schema cannot change without a changelog entry.
// There is no release build yet, so this runs in `npm run lint`.
//   node tools/check-plan-schema.ts           check
//   node tools/check-plan-schema.ts --write   regenerate the schema file and print its sha256
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadEngineFunction } from './engine-loader.ts';
import { validateAgainstSchema } from './json-schema-validator.ts';
import { reportProblems } from './workspace-packages.ts';

export const SCHEMA_PATH = 'docs/plan-language/plan.schema.json';
export const CHANGELOG_PATH = 'docs/plan-language/CHANGELOG.md';
const GOLDEN_PLANS = 'golden/plans';
const REGENERATE = 'node tools/check-plan-schema.ts --write';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

// The schema exactly as the committed file holds it: two-space JSON and a final line break.
async function builtSchema(root: string): Promise<{ readonly schema: unknown; readonly text: string }> {
  const schema = (await loadEngineFunction(root, 'planJsonSchema'))();
  return { schema, text: `${JSON.stringify(schema, null, 2)}\n` };
}

// The text of the newest changelog entry: from the first "## <version>" heading to the next heading.
export function newestChangelogEntry(changelog: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+\d+\.\d+/.test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function checkChangelog(root: string, schemaText: string): string[] {
  const path = join(root, CHANGELOG_PATH);
  if (!existsSync(path)) return [`${CHANGELOG_PATH} is missing`];
  const entry = newestChangelogEntry(readFileSync(path, 'utf8'));
  if (entry === undefined) return [`${CHANGELOG_PATH} has no "## <version>" entry`];
  const hash = sha256(schemaText);
  return entry.includes(hash)
    ? []
    : [`${CHANGELOG_PATH}: the newest entry does not name the schema's sha256 ${hash}; describe the schema change in a new entry that names it`];
}

function checkGoldenPlans(root: string, schema: unknown): string[] {
  const folder = join(root, GOLDEN_PLANS);
  if (!existsSync(folder)) return [`${GOLDEN_PLANS} is missing`];
  const problems: string[] = [];
  for (const name of readdirSync(folder).filter((file) => file.endsWith('.json')).sort()) {
    const file = `${GOLDEN_PLANS}/${name}`;
    let plan: unknown;
    try { plan = JSON.parse(readFileSync(join(folder, name), 'utf8')); } catch { problems.push(`${file} is not valid JSON`); continue; }
    for (const problem of validateAgainstSchema(schema, plan)) problems.push(`${file} does not validate against ${SCHEMA_PATH}: ${problem}`);
  }
  return problems;
}

export async function checkPlanSchema(root: string): Promise<string[]> {
  let built: { readonly schema: unknown; readonly text: string };
  try { built = await builtSchema(root); } catch (error) { return [`cannot build the plan schema: ${error instanceof Error ? error.message : String(error)}`]; }
  const problems: string[] = [];
  const schemaFile = join(root, SCHEMA_PATH);
  if (!existsSync(schemaFile)) {
    problems.push(`${SCHEMA_PATH} is missing; create it with ${REGENERATE}`);
  } else {
    const committed = readFileSync(schemaFile, 'utf8');
    if (committed !== built.text) problems.push(`${SCHEMA_PATH} is not what planJsonSchema() builds; regenerate it with ${REGENERATE} and add a changelog entry`);
    problems.push(...checkChangelog(root, committed));
  }
  try {
    problems.push(...checkGoldenPlans(root, built.schema));
  } catch (error) {
    problems.push(`cannot validate ${GOLDEN_PLANS}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}

async function main(root: string, flags: readonly string[]): Promise<number> {
  if (flags.includes('--write')) {
    const { text } = await builtSchema(root);
    mkdirSync(dirname(join(root, SCHEMA_PATH)), { recursive: true });
    writeFileSync(join(root, SCHEMA_PATH), text);
    console.log(`wrote ${SCHEMA_PATH} (sha256 ${sha256(text)}); name this hash in a new entry in ${CHANGELOG_PATH}`);
    return 0;
  }
  return reportProblems('plan schema check', await checkPlanSchema(root));
}

if (import.meta.main) process.exitCode = await main(process.cwd(), process.argv.slice(2));
