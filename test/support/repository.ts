// Where the test set lives on disk, so tests never build paths from their own location twice.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = join(REPOSITORY_ROOT, 'fixtures');
export const GOLDEN = join(REPOSITORY_ROOT, 'golden');
export const PACKAGES = join(REPOSITORY_ROOT, 'packages');
