import { readFileSync } from 'node:fs';
import { brand } from './brand.ts';

export const readReport = (path: string): string => brand(readFileSync(path, 'utf8'));
