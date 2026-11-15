// Blob storage gateway for the daily cloud sync.
//
//   PUT /api/blob-store?name=<snapshot>   body = snapshot bytes  -> stored at sync/<snapshot> (private, overwritten)
//   GET /api/blob-store?name=<snapshot>                          -> the stored bytes, 404 when absent
//
// The Python API keeps no credentials for storage: it calls this route with CRON_SECRET, and the official
// @vercel/blob SDK here uses the BLOB_READ_WRITE_TOKEN that Vercel injects when a Blob store is connected to
// the project (scripts/setup_cloud_sync.ps1).
import { get, put } from "@vercel/blob";
import { authorized, readBody, sendJson, snapshotPath } from "./_shared.mjs";

export default async function handler(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { detail: "unauthorized" });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return sendJson(res, 503, { detail: "BLOB_READ_WRITE_TOKEN is not set: connect a Blob store to the project" });
  }
  const name = new URL(req.url, "http://localhost").searchParams.get("name");
  const pathname = snapshotPath(name);
  if (!pathname) return sendJson(res, 400, { detail: "name must look like manifest.json or <source>.json.gz" });
  const contentType = name.endsWith(".gz") ? "application/gzip" : "application/json";
  try {
    if (req.method === "PUT") {
      const body = await readBody(req);
      if (!body.length) return sendJson(res, 400, { detail: "empty body" });
      const blob = await put(pathname, body, {
        access: "private", addRandomSuffix: false, allowOverwrite: true, contentType, cacheControlMaxAge: 60,
      });
      return sendJson(res, 200, { pathname: blob.pathname, size: body.length });
    }
    if (req.method === "GET") {
      const found = await get(pathname, { access: "private", useCache: false });
      if (!found) return sendJson(res, 404, { detail: `${pathname} not found` });
      const bytes = Buffer.from(await new Response(found.stream).arrayBuffer());
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "no-store");
      return res.end(bytes);
    }
    return sendJson(res, 405, { detail: "use GET or PUT" });
  } catch (err) {
    if (err && err.name === "BlobNotFoundError") return sendJson(res, 404, { detail: `${pathname} not found` });
    return sendJson(res, 502, { detail: `blob storage error: ${err && err.message ? err.message : err}` });
  }
}
