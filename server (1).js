/* ============================================================
   MPLR KPI Dashboard server (Railway) — upload-driven, no APIs
   - Serves the dashboard (public/mplr-kpi-dashboard.html)
   - Basic-auth protects everything (DASH_USER / DASH_PASS env vars)
   - Stores the dataset as JSON on disk (DATA_DIR → Railway volume)
   - Sheets uploaded in the dashboard save here automatically, so the
     page IS the live final page for everyone, on every device

   ENV VARS (Railway → Variables):
     DASH_USER, DASH_PASS   dashboard login (required)
     DATA_DIR               default /data (mount a Railway volume here)
   ============================================================ */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "mplr-kpi-data.json");

app.use(express.json({ limit: "25mb" }));

/* ---------------- basic auth ---------------- */
app.use((req, res, next) => {
  const user = process.env.DASH_USER, pass = process.env.DASH_PASS;
  if (!user || !pass) return next(); // no creds set = open; set them!
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const [u, p] = Buffer.from(encoded, "base64").toString().split(":");
    if (u === user && p === pass) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="MPLR KPI"');
  return res.status(401).send("Authentication required");
});

/* ---------------- storage ---------------- */
const EMPTY = { calls: [], jobs: [], ads: [], lsa: [], lsabill: [], manual: {}, numFilter: {}, numMeta: {}, mapMemory: {}, meta: {} };

function loadData() {
  try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) }; }
  catch (e) { return { ...EMPTY }; }
}
function saveData(d) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, DATA_FILE); // atomic: a crash mid-write can't corrupt the file
}

/* ---------------- routes ---------------- */
app.get("/api/data", (req, res) => res.json(loadData()));
app.post("/api/data", (req, res) => {
  const incoming = req.body || {};
  incoming.meta = { ...(loadData().meta || {}), lastUpdated: new Date().toISOString() };
  saveData({ ...EMPTY, ...incoming });
  res.json({ ok: true });
});
app.get("/api/health", (req, res) => res.json({ ok: true, lastUpdated: loadData().meta.lastUpdated || null }));

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "mplr-kpi-dashboard.html")));

app.listen(PORT, () => console.log(`MPLR KPI dashboard on :${PORT}, data at ${DATA_FILE}`));
