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
const EMPTY = { calls: [], jobs: [], ads: [], lsa: [], lsabill: [], estimates: [], kathy: [], lineitems: [], invoices: [], svcmix: [], followups: {}, settings: {}, manual: {}, numFilter: {}, numMeta: {}, mapMemory: {}, meta: {} };

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
  res.json({ ok: true, lastUpdated: d.meta.lastUpdated || null, aiGrading: !!process.env.ANTHROPIC_API_KEY, pendingAiGrades: d.kathy.filter((r) => !r.ai && r.cid && r.tx).length, kathyAiError: d.meta.kathyAiError || null });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "mplr-kpi-dashboard.html")));

app.listen(PORT, () => console.log(`MPLR KPI dashboard on :${PORT}, data at ${DATA_FILE}`));
