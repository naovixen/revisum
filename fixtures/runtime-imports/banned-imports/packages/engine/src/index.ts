// Names a test framework in data, never as an import.
import type { Plan } from '@revisum/contracts';

export const PLAYWRIGHT_TEST_INVOCATIONS: readonly (readonly string[])[] = [['playwright', 'test'], ['npx', 'playwright', 'test']];
export const planTitle = (plan: Plan): string => plan.meta.title;
