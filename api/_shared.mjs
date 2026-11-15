// Helpers shared by the Node.js functions of the daily cloud sync (files starting with "_" are not routes).
//
// Every sync route only answers requests that carry the project's CRON_SECRET as a bearer token: Vercel Cron
// sends it automatically, and the Python API (app/services/cloud_sync.py) sends it when it calls these routes.

export const SYNC_PREFIX = "sync/";
export const USER_AGENT = "IndiaManufacturingAtlas/1.0 (daily cloud sync)";

export function authorized(req) {
  const secret = (process.env.CRON_SECRET || "").trim();
  return Boolean(secret) && (req.headers.authorization || "") === `Bearer ${secret}`;
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/** Only flat snapshot names such as "manifest.json" or "cluster_observatory.json.gz". */
export function snapshotPath(name) {
  return /^[a-z0-9_]+\.json(\.gz)?$/.test(name || "") ? SYNC_PREFIX + name : null;
}
