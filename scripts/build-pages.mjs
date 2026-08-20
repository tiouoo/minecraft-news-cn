// Assembles the Cloudflare Pages output directory (dist/).
// Pages git builds use this as the build step; the output dir contains only
// what the site needs: the advanced-mode _worker.js plus the data files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(rootDir, '..');
const outDir = path.join(projectRoot, 'dist');

const filesToCopy = ['_worker.js', 'source', 'translate', '.assetsignore'];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const item of filesToCopy) {
  const src = path.join(projectRoot, item);
  const dest = path.join(outDir, item);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  }
}

console.log(`Pages build output written to ${outDir}`);
