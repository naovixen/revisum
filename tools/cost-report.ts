// The monthly hosted-cost report. While there are no customers, hosted spend must stay at or under
// USD 5 a month. There is no hosted service and no billing access, so spend is a declared record,
// docs/costs/hosted-costs.json: the month, the customer count, and one line per hosted service
// with its plan, monthly cost in USD and `source: "declared"`. The founder updates it monthly and
// whenever a paid service is added. Nothing here reads an account or an API.
//   npm run cost-report     print the month's report; fail when over budget at zero customers
// The lint runs the same check, so a committed record over budget fails CI.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COST_RECORD_PATH = 'docs/costs/hosted-costs.json';
// The budget at zero customers, in cents so sums are exact.
export const ZERO_CUSTOMER_BUDGET_CENTS = 500;

export type HostedService = {
  readonly service: string;
  readonly plan: string;
  readonly monthlyUsd: number;
  readonly source: 'declared';
};

export type HostedCosts = {
  readonly month: string;
  readonly customers: number;
  readonly services: readonly HostedService[];
};

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function decodeHostedCosts(input: unknown): HostedCosts {
  const month = fieldOf(input, 'month');
  const customers = fieldOf(input, 'customers');
  const services = fieldOf(input, 'services');
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw new Error('month is not of the form YYYY-MM');
  if (typeof customers !== 'number' || !Number.isInteger(customers) || customers < 0) throw new Error('customers is not a whole number');
  if (!Array.isArray(services)) throw new Error('services is not a list');
  return {
    month,
    customers,
    services: services.map((line, index) => {
      const service = fieldOf(line, 'service');
      const plan = fieldOf(line, 'plan');
      const monthlyUsd = fieldOf(line, 'monthlyUsd');
      const source = fieldOf(line, 'source');
      if (typeof service !== 'string' || typeof plan !== 'string') throw new Error(`services[${index}] needs a service and a plan`);
      if (!isAmount(monthlyUsd)) throw new Error(`services[${index}].monthlyUsd is not an amount in USD`);
      if (source !== 'declared') throw new Error(`services[${index}].source is not "declared"`);
      return { service, plan, monthlyUsd, source };
    }),
  };
}

const centsOf = (usd: number): number => Math.round(usd * 100);
const usd = (cents: number): string => `USD ${(cents / 100).toFixed(2)}`;

export type CostReport = { readonly lines: readonly string[]; readonly problems: readonly string[] };

export function costReport(root: string): CostReport {
  const path = join(root, COST_RECORD_PATH);
  if (!existsSync(path)) return { lines: [], problems: [`${COST_RECORD_PATH} is missing`] };
  let costs: HostedCosts;
  try {
    costs = decodeHostedCosts(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return { lines: [], problems: [`${COST_RECORD_PATH}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const totalCents = costs.services.reduce((sum, line) => sum + centsOf(line.monthlyUsd), 0);
  const lines = [
    `Hosted costs for ${costs.month} (declared, ${costs.customers} customer(s)):`,
    ...costs.services.map((line) => `  ${line.service}: ${usd(centsOf(line.monthlyUsd))} (${line.plan})`),
    `  Total: ${usd(totalCents)}`,
  ];
  const problems = costs.customers === 0 && totalCents > ZERO_CUSTOMER_BUDGET_CENTS
    ? [`${COST_RECORD_PATH}: hosted spend is ${usd(totalCents)} at zero customers, over the ${usd(ZERO_CUSTOMER_BUDGET_CENTS)} budget`]
    : [];
  return { lines, problems };
}

if (import.meta.main) {
  const report = costReport(process.cwd());
  for (const line of report.lines) console.log(line);
  for (const problem of report.problems) console.error(`cost report: ${problem}`);
  console.log(report.problems.length === 0 ? 'cost report passed' : 'cost report failed');
  process.exitCode = report.problems.length === 0 ? 0 : 1;
}
