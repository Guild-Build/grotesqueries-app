import { fileURLToPath } from 'node:url';
import { assertSourceNode } from './licenses.mjs';

try {
  assertSourceNode(fileURLToPath(new URL('../', import.meta.url)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
