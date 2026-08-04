import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sourceRoot = path.resolve('src');
const forbidden: Record<string, string[]> = {
  domain: ['application', 'infrastructure', 'interfaces'],
  application: ['infrastructure', 'interfaces'],
  infrastructure: ['interfaces']
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : /\.(?:ts|tsx)$/u.test(entry.name) ? [target] : [];
  });
}

test('DDD layers only depend inward', () => {
  const violations: string[] = [];
  for (const [layer, forbiddenLayers] of Object.entries(forbidden)) {
    for (const file of sourceFiles(path.join(sourceRoot, layer))) {
      const source = readFileSync(file, 'utf8');
      for (const forbiddenLayer of forbiddenLayers) {
        const pattern = new RegExp(`from\\s+['\"][^'\"]*\\b${forbiddenLayer}\\b`, 'u');
        if (pattern.test(source)) {
          violations.push(`${path.relative(sourceRoot, file)} imports ${forbiddenLayer}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
