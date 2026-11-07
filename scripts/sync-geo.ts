/**
 * Copies Natural Earth TopoJSON (public domain data, packaged by `world-atlas`, ISC)
 * into `public/geo/` so the map island can fetch it from the CDN.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const atlasDir = dirname(require.resolve('world-atlas/package.json'));
const outDir = join(ROOT, 'public', 'geo');

await mkdir(outDir, { recursive: true });
await copyFile(join(atlasDir, 'countries-110m.json'), join(outDir, 'countries-110m.topo.json'));
console.log('Synced public/geo/countries-110m.topo.json');
