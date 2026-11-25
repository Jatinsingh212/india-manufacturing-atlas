// Build step for Cloudflare Pages: rebuild the dashboard, then add _headers and _worker.js (the /api proxy) to it.
import { execSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..', 'frontend');
const dist = join(frontend, 'dist');

execSync('npm run build', { cwd: frontend, stdio: 'inherit' });
copyFileSync(join(here, '_headers'), join(dist, '_headers'));
copyFileSync(join(here, 'worker.js'), join(dist, '_worker.js'));
