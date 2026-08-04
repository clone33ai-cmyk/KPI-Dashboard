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

const SERVER_BUILD = 62;

/* ================= HCP DIRECT SYNC =================
   Pulls every job + its line items straight from the Housecall Pro API.
   Needs env var HCP_API_KEY (Railway → Variables). */
const HCP_KEY = process.env.HCP_API_KEY || "";
const HCP_BASE = "https://api.housecallpro.com";
const syncState = { running: false, startedAt: null, finishedAt: null, phase: "", pages: 0, jobsSeen: 0, liFetched: 0, liFailures: 0, merged: 0, created: 0, descFilled: 0, error: null, authHint: null };

async function hcpFetch(path, tries = 5) {
  for (let a = 1; a <= tries; a++) {
    const r = await fetch(HCP_BASE + path, { headers: { Authorization: "Bearer " + HCP_KEY, Accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) {
      const ra = Number(r.headers && r.headers.get && r.headers.get("retry-after")) || 0;
      const wait = ra > 0 ? ra * 1000 : Math.min(15000, 800 * Math.pow(2, a)) + Math.random() * 500;
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (r.status === 401 || r.status === 403) { const e = new Error("HCP rejected the API key (HTTP " + r.status + ")"); e.auth = true; throw e; }
    if (!r.ok) throw new Error("HCP " + path.split("?")[0] + " → HTTP " + r.status);
    return r.json();
  }
  throw new Error("HCP kept rate-limiting " + path.split("?")[0]);
}

/* line items can span pages — fetch them all */
async function hcpAllLineItems(jobId) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const body = await hcpFetch(`/jobs/${jobId}/line_items?page=${page}&page_size=200`);
    const list = body.data || body.line_items || (Array.isArray(body) ? body : []);
    out.push(...list);
    if (!list.length || list.length < 200) break;
  }
  return out;
}

function centsToDollars(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) / 100 : 0; }

async function runHcpSync() {
  syncState.running = true;
  Object.assign(syncState, { startedAt: new Date().toISOString(), finishedAt: null, phase: "listing jobs", pages: 0, jobsSeen: 0, liFetched: 0, liFailures: 0, merged: 0, created: 0, descFilled: 0, estimates: 0, estimatesError: null, error: null, authHint: null });
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
    const failedJobs = [];
    let idx = 0;
    const workers = Array.from({ length: 5 }, async () => {
      while (idx < apiJobs.length) {
        const j = apiJobs[idx++];
        const jid = String(j.invoice_number || j.id || "").trim();
        if (!jid) continue;
        if (j.description) descByJid[jid] = String(j.description).slice(0, 90);
        try {
          let items = Array.isArray(j.line_items) ? j.line_items : null;
          if (!items) items = await hcpAllLineItems(j.id);
          liByJid[jid] = { hid: j.id, items: (items || []).map((li) => ({
            n: String(li.name || li.description || "item").slice(0, 80),
            amt: li.amount != null ? centsToDollars(li.amount) : centsToDollars(li.unit_price) * (Number(li.quantity) || 1),
          })).filter((x) => x.n) };
          syncState.liFetched++;
        } catch (e) {
          if (e.auth) throw e;
          failedJobs.push(j);
        }
      }
    });
    await Promise.all(workers);
    /* dedicated slow retry passes for whatever the rate limiter ate */
    for (let pass = 1; pass <= 2 && failedJobs.length; pass++) {
      syncState.phase = `retrying ${failedJobs.length} failed line-item fetches (pass ${pass})`;
      const again = failedJobs.splice(0);
      for (const j of again) {
        const jid = String(j.invoice_number || j.id || "").trim();
        try {
          const items = await hcpAllLineItems(j.id);
          liByJid[jid] = { hid: j.id, items: (items || []).map((li) => ({
            n: String(li.name || li.description || "item").slice(0, 80),
            amt: li.amount != null ? centsToDollars(li.amount) : centsToDollars(li.unit_price) * (Number(li.quantity) || 1),
          })).filter((x) => x.n) };
          syncState.liFetched++;
        } catch (e) {
          if (e.auth) throw e;
          failedJobs.push(j);
        }
        await new Promise((r) => setTimeout(r, 350)); /* gentle pace */
      }
    }
    syncState.liFailures = failedJobs.length;
    syncState.failedJobIds = failedJobs.slice(0, 50).map((j) => String(j.invoice_number || j.id));
    syncState.phase = "merging into the dashboard data";
    const d = loadData();
    const jobs = d.jobs || [];
    const byJid = new Map(jobs.map((j) => [String(j.jid), j]));
    const byBase = new Map();
    for (const j of jobs) { const b = String(j.jid).split("-")[0]; if (!byBase.has(b)) byBase.set(b, j); }
    const apiByJid = new Map();
    for (const aj of apiJobs) { const k = String(aj.invoice_number || aj.id || "").trim(); if (k) apiByJid.set(k, aj); }
    for (const [jid, entry] of Object.entries(liByJid)) {
      const tgt = byJid.get(jid) || byJid.get(jid.replace(/-.*$/, "")) || byBase.get(jid.split("-")[0]);
      if (!tgt) continue;
      if (entry.items.length) { tgt.li = entry.items; tgt.hid = entry.hid; syncState.merged++; }
      if (!tgt.jd && descByJid[jid]) { tgt.jd = descByJid[jid]; syncState.descFilled++; }
    }
    /* refresh payment state on EXISTING rows so jobs that get paid after
       first sight update themselves — no sheet needed. Exact paid dates
       from a sheet upload are never overwritten, only filled when absent. */
    for (const [jid, aj] of apiByJid) {
      const tgt = byJid.get(jid) || byJid.get(jid.replace(/-.*$/, "")) || byBase.get(jid.split("-")[0]);
      if (!tgt) continue;
      const total = centsToDollars(aj.total_amount);
      const out = centsToDollars(aj.outstanding_balance);
      if (total > 0) { tgt.amt = total; tgt.paidAmt = Math.max(0, total - out); }
      const nowPaid = total > 0 && out <= 0;
      if (nowPaid && !tgt.pd) {
        const doneAt = (aj.work_timestamps && String(aj.work_timestamps.completed_at || "").slice(0, 10)) || null;
        tgt.pd = doneAt || String(aj.created_at || "").slice(0, 10) || tgt.d;
        syncState.paidUpdated = (syncState.paidUpdated || 0) + 1;
      }
      if (/complete/i.test(String(aj.work_status || ""))) tgt.done = true;
      if (!tgt.hid) tgt.hid = aj.id;
    }
    /* UPSERT: any API job the store doesn't have gets created outright, so
       the sync can rebuild from zero — a cleared sheet is no longer fatal.
       Paid date approximates to the completion date once the balance is 0. */
    for (const aj of apiJobs) {
      const jid = String(aj.invoice_number || aj.id || "").trim();
      if (!jid || byJid.has(jid) || byBase.has(jid.split("-")[0])) continue;
      const total = centsToDollars(aj.total_amount);
      const out = centsToDollars(aj.outstanding_balance);
      const created = String(aj.created_at || "").slice(0, 10) || null;
      const doneAt = (aj.work_timestamps && String(aj.work_timestamps.completed_at || "").slice(0, 10)) || null;
      const cust = aj.customer || {};
      const nj = {
        jid, d: created || doneAt, amt: total,
        paidAmt: Math.max(0, total - out),
        pd: total > 0 && out <= 0 ? (doneAt || created) : null,
        done: /complete/i.test(String(aj.work_status || "")),
        jd: descByJid[jid] || "",
        ph: String(cust.mobile_number || cust.home_number || cust.work_number || "").replace(/\D/g, "").slice(-10),
        hid: aj.id,
      };
      const entry = liByJid[jid];
      if (entry && entry.items.length) nj.li = entry.items;
      if (nj.d) { jobs.push(nj); byJid.set(jid, nj); syncState.created++; }
    }
    d.jobs = jobs.sort((a, b) => (a.d < b.d ? -1 : 1));
    /* ============ estimates straight from HCP ============ */
    syncState.phase = "syncing estimates";
    const apiEst = [];
    try {
      for (let page = 1; page < 300; page++) {
        const body = await hcpFetch(`/estimates?page=${page}&page_size=100`);
        const list = body.estimates || body.data || (Array.isArray(body) ? body : []);
        if (!list.length) break;
        for (const e of list) apiEst.push(e);
        if (body.total_pages && page >= body.total_pages) break;
      }
      const mapped = apiEst.map((e) => {
        const opts = Array.isArray(e.options) ? e.options : [];
        const statuses = opts.map((o) => String(o.approval_status || "").toLowerCase());
        const approved = opts.find((o, i) => statuses[i] === "approved" || statuses[i] === "pro approved");
        const declinedAll = opts.length > 0 && statuses.every((s) => s.includes("declin"));
        const pick = approved || opts.reduce((a, b) => (centsToDollars(b.total_amount) > centsToDollars(a && a.total_amount || 0) ? b : a), opts[0]) || null;
        const cust = e.customer || {};
        const oc = approved ? "won" : declinedAll ? "lost" : "open";
        return {
          eid: String(e.estimate_number || e.id || "").trim(),
          d: String(e.created_at || "").slice(0, 10) || null,
          amt: pick ? centsToDollars(pick.total_amount) : 0,
          nm: [cust.first_name, cust.last_name].filter(Boolean).join(" ") || "",
          ph: String(cust.mobile_number || cust.home_number || cust.work_number || "").replace(/\D/g, "").slice(-10),
          st: (pick && pick.approval_status) || e.work_status || "submitted",
          oc, closed: oc !== "open",
          hid: e.id,
        };
      }).filter((x) => x.eid && x.d);
      if (mapped.length) { d.estimates = mapped; syncState.estimates = mapped.length; }
    } catch (e) {
      if (e.auth) throw e;
      syncState.estimatesError = e.message; /* estimates endpoint problems never sink the job sync */
    }
    d.meta = d.meta || {};
    d.meta.hcpSync = { at: new Date().toISOString(), jobs: apiJobs.length, withLineItems: syncState.merged, estimates: syncState.estimates || 0 };
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

/* nightly auto-sync at 2:00 AM Central, so nobody uploads sheets daily */
function msUntil2amCT() {
  const nowCT = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const next = new Date(nowCT);
  next.setHours(2, 0, 0, 0);
  if (next <= nowCT) next.setDate(next.getDate() + 1);
  return Math.max(60000, next - nowCT);
}
function scheduleNightlySync() {
  if (!HCP_KEY) return;
  const ms = msUntil2amCT();
  syncState.nextAutoSync = new Date(Date.now() + ms).toISOString();
  setTimeout(async () => {
    try { if (!syncState.running) await runHcpSync(); } catch (e) { /* recorded in syncState */ }
    scheduleNightlySync();
  }, ms);
}
scheduleNightlySync();

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
