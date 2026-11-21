import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { build } from '../src/build.js';

const distDir = join(import.meta.dirname, '..', 'dist');

/**
 * Gives the test run a freshly built `dist/` to assert against. Test files only read it.
 */
export async function globalSetup() {
  await rm(distDir, { recursive: true, force: true });
  await build();
}
