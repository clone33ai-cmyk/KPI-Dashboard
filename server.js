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

const SERVER_BUILD = 56;

/* ================= HCP DIRECT SYNC =================
   Pulls every job + its line items straight from the Housecall Pro API.
   Needs env var HCP_API_KEY (Railway → Variables). */
const HCP_KEY = process.env.HCP_API_KEY || "";
const HCP_BASE = "https://api.housecallpro.com";
const syncState = { running: false, startedAt: null, finishedAt: null, phase: "", pages: 0, jobsSeen: 0, liFetched: 0, liFailures: 0, merged: 0, descFilled: 0, error: null, authHint: null };

async function hcpFetch(path, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    const r = await fetch(HCP_BASE + path, { headers: { Authorization: "Bearer " + HCP_KEY, Accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 1200 * a)); continue; }
    if (r.status === 401 || r.status === 403) { const e = new Error("HCP rejected the API key (HTTP " + r.status + ")"); e.auth = true; throw e; }
    if (!r.ok) throw new Error("HCP " + path.split("?")[0] + " → HTTP " + r.status);
    return r.json();
  }
  throw new Error("HCP kept rate-limiting " + path.split("?")[0]);
}

function centsToDollars(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) / 100 : 0; }

async function runHcpSync() {
  syncState.running = true;
  Object.assign(syncState, { startedAt: new Date().toISOString(), finishedAt: null, phase: "listing jobs", pages: 0, jobsSeen: 0, liFetched: 0, liFailures: 0, merged: 0, descFilled: 0, error: null, authHint: null });
  try {
    const apiJobs = [];
    for (let page = 1; page < 500; page++) {
      const body = await hcpFetch(`/jobs?page=${page}&page_size=100`);
      const list = body.jobs || body.data || (Array.isArray(body) ? body : []);
      if (!list.length) break;
      syncState.pages = page; 
      for (const j of list) apiJobs.push(j);
      syncState.jobsSeen = apiJobs.length;
      if (body.total_pages && page >= body.total_pages) break;
    }
    syncState.phase = "fetching line items";
    const liByJid = {};
    const descByJid = {};
    let idx = 0;
    const workers = Array.from({ length: 5 }, async () => {
      while (idx < apiJobs.length) {
        const j = apiJobs[idx++];
        const jid = String(j.invoice_number || j.id || "").trim();
        if (!jid) continue;
        if (j.description) descByJid[jid] = String(j.description).slice(0, 90);
        try {
          let items = Array.isArray(j.line_items) ? j.line_items : null;
          if (!items) {
            const body = await hcpFetch(`/jobs/${j.id}/line_items`);
            items = body.data || body.line_items || (Array.isArray(body) ? body : []);
          }
          liByJid[jid] = (items || []).map((li) => ({
            n: String(li.name || li.description || "item").slice(0, 80),
            amt: li.amount != null ? centsToDollars(li.amount) : centsToDollars(li.unit_price) * (Number(li.quantity) || 1),
          })).filter((x) => x.n);
          syncState.liFetched++;
        } catch (e) {
          if (e.auth) throw e;
          syncState.liFailures++;
        }
      }
    });
    await Promise.all(workers);
    syncState.phase = "merging into the dashboard data";
    const d = loadData();
    const jobs = d.jobs || [];
    const byJid = new Map(jobs.map((j) => [String(j.jid), j]));
    for (const [jid, items] of Object.entries(liByJid)) {
      const tgt = byJid.get(jid) || byJid.get(jid.replace(/-.*$/, ""));
      if (!tgt) continue;
      if (items.length) { tgt.li = items; syncState.merged++; }
      if (!tgt.jd && descByJid[jid]) { tgt.jd = descByJid[jid]; syncState.descFilled++; }
    }
    d.meta = d.meta || {};
    d.meta.hcpSync = { at: new Date().toISOString(), jobs: apiJobs.length, withLineItems: syncState.merged };
    saveData(d);
    syncState.phase = "done";
  } catch (e) {
    syncState.error = e.message;
    if (e.auth) syncState.authHint = "Add/verify HCP_API_KEY in Railway → Variables, then redeploy.";
  } finally {
    syncState.running = false;
    syncState.finishedAt = new Date().toISOString();
  }
}

app.post("/api/hcp/sync", (req, res) => {
  if (!HCP_KEY) return res.status(400).json({ error: "HCP_API_KEY is not set on the server. Add it in Railway → Variables and redeploy." });
  if (syncState.running) return res.json({ started: false, alreadyRunning: true });
  runHcpSync();
  res.json({ started: true });
});
app.get("/api/hcp/sync/status", (req, res) => res.json(syncState));

app.use(express.json({ limit: "100mb" }));

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
const EMPTY = { calls: [], jobs: [], ads: [], lsa: [], lsabill: [], kathy: [], settings: {}, manual: {}, numFilter: {}, numMeta: {}, mapMemory: {}, meta: {} };

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

/* ---------------- optional AI grading (Spam Kathy audit) ----------------
   Set ANTHROPIC_API_KEY in Railway Variables to enable. The dashboard's
   "AI-grade calls" button sends transcripts here; Claude reads each one and
   returns real / spam / unknown. Costs fractions of a cent per call. */
async function gradeBatchViaClaude(capped) {
  const key = process.env.ANTHROPIC_API_KEY;
  const grades = {};
  {
    for (let i = 0; i < capped.length; i += 20) {
      const batch = capped.slice(i, i + 20);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          system: 'You audit call transcripts for a pool leak repair company\'s AI phone screener. For each transcript, judge the CALLER\'s intent only. "real" = a genuine current or potential customer: pool/leak/repair needs, scheduling, questions about work or invoices, returning a call from the company. "spam" = sales pitches, robocalls, business-listing or SEO or website offers, lending/credit, insurance, solar, surveys, or anyone selling anything. Note: spam callers often recite the business name ("Mr Pool Leak Repair") — that does not make them real. "unknown" = hung up early or too garbled to judge. Respond with ONLY a JSON object mapping each id to "real", "spam", or "unknown". No other text.',
          messages: [{ role: "user", content: JSON.stringify(batch.map((c) => ({ id: c.cid, transcript: String(c.tx || "").slice(0, 1500) }))) }],
        }),
      });
      if (!r.ok) throw new Error("Anthropic API " + r.status);
      const j = await r.json();
      const text = (j.content || []).map((b) => b.text || "").join("");
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      Object.entries(parsed).forEach(([id, v]) => {
        if (["real", "spam", "unknown"].includes(v)) grades[id] = v;
      });
    }
  }
  return grades;
}

/* automatic grading: reads the store, grades every ungraded transcript,
   writes results back. Fired after uploads, on boot, and hourly. */
let grading = false;
async function autoGradeKathy() {
  if (grading || !process.env.ANTHROPIC_API_KEY) return { skipped: true };
  const pending = loadData().kathy.filter((r) => !r.ai && r.cid && r.tx);
  if (!pending.length) return { graded: 0 };
  grading = true;
  try {
    const grades = await gradeBatchViaClaude(pending.slice(0, 400).map((c) => ({ cid: c.cid, tx: c.tx })));
    /* reload fresh before writing so concurrent uploads aren't clobbered */
    const data = loadData();
    let changed = 0;
    data.kathy = data.kathy.map((row) => {
      const g = row.cid && grades[row.cid];
      if (!g) return row;
      if (g !== row.intent) changed++;
      return { ...row, intent: g, ai: true };
    });
    data.meta.kathyAiLastRun = new Date().toISOString();
    data.meta.kathyAiError = null;
    saveData(data);
    return { graded: Object.keys(grades).length, changed };
  } catch (e) {
    const data = loadData();
    data.meta.kathyAiError = e.message;
    saveData(data);
    return { error: e.message };
  } finally { grading = false; }
}
setInterval(() => autoGradeKathy().catch(() => {}), 60 * 60 * 1000);
setTimeout(() => autoGradeKathy().catch(() => {}), 20 * 1000);

app.post("/api/kathy-grade", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set in Railway Variables" });
  res.json(await autoGradeKathy());
});

/* ---------------- routes ---------------- */
app.get("/api/data", (req, res) => res.json(loadData()));
app.post("/api/data", (req, res) => {
  const incoming = req.body || {};
  incoming.meta = { ...(loadData().meta || {}), lastUpdated: new Date().toISOString() };
  saveData({ ...EMPTY, ...incoming });
  res.json({ ok: true });
  /* grade any new transcripts in the background */
  setTimeout(() => autoGradeKathy().catch(() => {}), 1500);
});
app.get("/api/health", (req, res) => {
  const d = loadData();
  res.json({ ok: true, serverBuild: SERVER_BUILD, uploadLimit: "100mb", hcpSyncConfigured: !!HCP_KEY, lastUpdated: d.meta.lastUpdated || null, aiGrading: !!process.env.ANTHROPIC_API_KEY, pendingAiGrades: d.kathy.filter((r) => !r.ai && r.cid && r.tx).length, kathyAiError: d.meta.kathyAiError || null });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "mplr-kpi-dashboard.html")));

app.listen(PORT, () => console.log(`MPLR KPI dashboard on :${PORT}, data at ${DATA_FILE}`));
