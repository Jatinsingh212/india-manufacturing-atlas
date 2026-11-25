// Published as _worker.js on Cloudflare Pages (build.mjs copies it): forwards /api/* to the Atlas backend on
// Vercel; everything else is the static dashboard (see wrangler.jsonc).
const DEFAULT_API_ORIGIN = 'https://india-manufacturing-atlas-git.vercel.app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const target = new URL(url.pathname + url.search, env.API_ORIGIN || DEFAULT_API_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

    try {
      return await fetch(target, init);
    } catch (err) {
      return Response.json({ detail: 'The Atlas backend could not be reached.' }, { status: 502 });
    }
  },
};
