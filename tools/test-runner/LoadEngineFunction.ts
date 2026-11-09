// Loads a function from the engine of the repository a tool is checking, at run time. Tools are
// compiled on their own, without the packages, so they reach the engine this way rather than
// through a typed import. A missing export fails loudly, naming it.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type EngineFunction = (...values: readonly unknown[]) => unknown;

export async function loadEngineFunction(root: string, name: string): Promise<EngineFunction> {
  const loaded: unknown = await import(pathToFileURL(join(root, 'packages', 'engine', 'src', 'index.ts')).href);
  const exported: unknown = typeof loaded === 'object' && loaded !== null ? Object.getOwnPropertyDescriptor(loaded, name)?.value : undefined;
  if (typeof exported !== 'function') throw new Error(`the engine does not export a function named ${name}`);
  return (...values) => Reflect.apply(exported, undefined, values);
}
