// India Industrial Land Bank park report, read in the cloud for the daily sync.
//
//   GET /api/iilb-report   (CRON_SECRET)  -> stores sync/iilb_parks.json.gz and returns {records, fetched_at, ...}
//
// The public report (https://indiaindustriallandbank.gov.in/exploreParkReport, no login) loads its rows through
// the page's own encrypted request, so the Atlas never calls that endpoint itself. A serverless Chromium
// (@sparticuz/chromium + puppeteer-core) opens the page, chooses "All" entries and reads the table - exactly what
// the local connector does with Playwright (backend/app/services/connectors/deep_dive.py, fetch_park_report).
// The snapshot has the same shape as data/raw/iilb_parks.json, so the Python loaders apply it unchanged.
import { gzipSync } from "node:zlib";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { put } from "@vercel/blob";
import { authorized, sendJson, SYNC_PREFIX, USER_AGENT } from "./_shared.mjs";

const REPORT_URL = "https://indiaindustriallandbank.gov.in/exploreParkReport";
const COLUMNS = ["sr_no", "park_id", "user", "user_level", "state", "district", "park_name", "industrial_park_type",
  "total_area_ha", "total_area_acres", "available_area_ha", "plug_and_play", "park_type", "sector",
  "land_category", "upload_mode", "created", "updated"];
const MIN_PARKS = 1000;
const TIMEOUT_MS = 150_000;

async function readReport() {
  const browser = await puppeteer.launch({
    args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
    executablePath: await chromium.executablePath(),
    headless: "shell",
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForSelector("#selection tbody tr td", { timeout: TIMEOUT_MS });
    await page.select("select[name='selection_length']", "-1");
    await page.waitForFunction(() => {
      const info = document.querySelector(".dataTables_info");
      const m = info && info.innerText.match(/to ([\d,]+) of ([\d,]+)/);
      return m && m[1] === m[2] && document.querySelectorAll("#selection tbody tr").length > 10;
    }, { timeout: TIMEOUT_MS, polling: 1000 });
    return await page.evaluate(() => [...document.querySelectorAll("#selection tbody tr")]
      .map((r) => [...r.cells].slice(0, 18).map((c) => c.innerText.trim())));
  } finally {
    await browser.close();
  }
}

export default async function handler(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { detail: "unauthorized" });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return sendJson(res, 503, { detail: "BLOB_READ_WRITE_TOKEN is not set: connect a Blob store to the project" });
  }
  const started = Date.now();
  let cells;
  try {
    cells = await readReport();
  } catch (err) {
    return sendJson(res, 502, { detail: `could not read the IILB park report: ${err && err.message ? err.message : err}` });
  }
  const parks = cells.filter((row) => row.length >= COLUMNS.length)
    .map((row) => Object.fromEntries(COLUMNS.map((col, i) => [col, row[i]])));
  if (parks.length < MIN_PARKS) {
    return sendJson(res, 502, { detail: `the park report returned only ${parks.length} parks - not stored` });
  }
  const fetchedAt = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const body = gzipSync(JSON.stringify({ fetched_at: fetchedAt, source: "park_report", parks }));
  await put(`${SYNC_PREFIX}iilb_parks.json.gz`, body, {
    access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/gzip", cacheControlMaxAge: 60,
  });
  const available = parks.reduce((sum, p) => sum + (parseFloat(p.available_area_ha) || 0), 0);
  return sendJson(res, 200, {
    records: parks.length, fetched_at: fetchedAt, available_ha: Math.round(available),
    seconds: Math.round((Date.now() - started) / 1000),
  });
}
