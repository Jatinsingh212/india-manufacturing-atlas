// Build step for Cloudflare Pages: rebuild the dashboard, then add _headers and _worker.js (the /api proxy) to it.
// Used both by `npm run deploy` here and by Cloudflare's Git builds (build command `node cloudflare/build.mjs`,
// output directory `frontend/dist`), which start from a clean checkout, so it installs the dashboard's packages first.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..', 'frontend');
const dist = join(frontend, 'dist');

if (!existsSync(join(frontend, 'node_modules'))) {
  execSync('npm ci --no-audit --no-fund', { cwd: frontend, stdio: 'inherit' });
}
execSync('npm run build', { cwd: frontend, stdio: 'inherit' });
copyFileSync(join(here, '_headers'), join(dist, '_headers'));
copyFileSync(join(here, 'worker.js'), join(dist, '_worker.js'));
