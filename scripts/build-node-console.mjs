import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await build({
  entryPoints: ['src/interfaces/http/console/node-entry.ts'],
  outfile: 'dist/node-console/index.mjs',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: true,
  minify: true,
  plugins: [{
    name: 'gateway-source',
    setup(plugin) {
      plugin.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw'
      }));
      plugin.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
        contents: await readFile(args.path, 'utf8'), loader: 'text'
      }));
    }
  }]
});
