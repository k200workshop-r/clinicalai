/* AI 臨床推理模擬訓練平台 — 後端伺服器
 * 功能：
 *   1. 提供前端靜態網站（public/）
 *   2. 代理 Google Gemini API（API key 只存在伺服器，不外洩到前端）
 *   3. 各組紀錄與教師標準答案：優先存於 Render Key Value（設定 REDIS_URL 時），否則用本機檔案
 *   4. 教師後台以密碼登入換取 token，標準答案僅在通過驗證後才回傳
 */
require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const store = require("./lib/store");

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const TEACHER_PASSCODE = process.env.TEACHER_PASSCODE || "teacher2024";
const BUILD = "2026-06-19l";

/* ---------- 教師 token（記憶體，8 小時效期）---------- */
const tokens = new Map();
function newToken() {
  const t = crypto.randomBytes(24).toString("hex");
  tokens.set(t, Date.now() + 1000 * 60 * 60 * 8);
  return t;
}
function validToken(t) {
  const exp = tokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { tokens.delete(t); return false; }
  return true;
}
function teacherAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.replace(/^Bearer\s+/i, "");
  if (validToken(t)) return next();
  res.status(401).json({ error: "unauthorized" });
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- 簡易速率限制（避免 AI 代理被濫用）---------- */
const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || "x";
  const WIN = 60 * 1000, MAX = 40;
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < WIN);
  arr.push(t);
  hits.set(key, arr);
  if (arr.length > MAX) return res.status(429).json({ error: "rate_limited", message: "請稍候再試。" });
  next();
}

/* ---------- AI 代理（含過載自動備援）---------- */
function buildPayload(model, system, user) {
  const genConfig = { maxOutputTokens: 8192, temperature: 0.4 };
  // 思考量越低、回應越快。Gemini 3.x 用 thinkingLevel，2.x 用 thinkingBudget（不可混用）
  const THINK = (process.env.GEMINI_THINKING || "low").trim().toLowerCase();
  if (model.startsWith("gemini-3")) {
    const lvl = ["minimal", "low", "medium", "high"].includes(THINK) ? THINK : "low";
    genConfig.thinkingConfig = { thinkingLevel: lvl };
  } else {
    const budget = { off: 0, minimal: 0, low: 512, medium: 4096, high: 12288 };
    genConfig.thinkingConfig = { thinkingBudget: (THINK in budget) ? budget[THINK] : 512 };
  }
  const payload = {
    contents: [{ role: "user", parts: [{ text: String(user) }] }],
    generationConfig: genConfig,
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };
  if (system) payload.system_instruction = { parts: [{ text: String(system) }] };
  return payload;
}
async function callGemini(model, system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(buildPayload(model, system, user)),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    return { ok: false, status: r.status, detail };
  }
  const data = await r.json();
  const cand = (data.candidates || [])[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.map((p) => p.text || "").join("").trim() : "";
  if (!text) {
    const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || "empty";
    return { ok: false, empty: true, reason };
  }
  return { ok: true, text };
}
app.post("/api/ai", rateLimit, async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "no_key", message: "伺服器尚未設定 GEMINI_API_KEY。" });
  const { system, user } = req.body || {};
  if (!user) return res.status(400).json({ error: "bad_request" });
  const FALLBACK = (process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite").trim();
  try {
    let result = await callGemini(MODEL, system, user);
    // 主模型過載／限流／暫時性錯誤（503/429/500）→ 自動改用備援模型再試一次
    if (!result.ok && !result.empty && [429, 500, 503].includes(result.status) && FALLBACK && FALLBACK !== MODEL) {
      const fb = await callGemini(FALLBACK, system, user);
      if (fb.ok) return res.json({ text: fb.text, modelUsed: FALLBACK });
    }
    if (result.ok) return res.json({ text: result.text, modelUsed: MODEL });
    if (result.empty) return res.status(502).json({ error: "empty_response", reason: result.reason });
    return res.status(502).json({ error: "upstream", status: result.status, detail: result.detail });
  } catch (e) {
    res.status(502).json({ error: "fetch_failed", message: String(e) });
  }
});

/* ---------- 教師登入與標準答案 ---------- */
app.post("/api/teacher/login", (req, res) => {
  const input = String((req.body && req.body.passcode) || "").trim();
  if (input && input === String(TEACHER_PASSCODE).trim()) {
    res.json({ token: newToken() });
  } else {
    res.status(401).json({ error: "bad_passcode" });
  }
});
app.get("/api/teacher-answers", teacherAuth, async (req, res) => {
  try { res.json({ answers: await store.getTeacherAnswers() }); }
  catch (e) { res.status(500).json({ error: "store", message: String(e) }); }
});
app.post("/api/teacher-answers", teacherAuth, async (req, res) => {
  const s = Number(req.body && req.body.session);
  if (!(s >= 1 && s <= 4)) return res.status(400).json({ error: "bad_session" });
  try {
    await store.setTeacherAnswer(s, String((req.body && req.body.text) || ""));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "store", message: String(e) }); }
});

/* ---------- 各組紀錄 ---------- */
app.get("/api/records", teacherAuth, async (req, res) => {
  try { res.json({ records: await store.getRecords() }); }
  catch (e) { res.status(500).json({ error: "store", message: String(e) }); }
});
app.post("/api/records", async (req, res) => {
  const rec = req.body && req.body.record;
  if (!rec || !rec.group) return res.status(400).json({ error: "bad_record" });
  try { await store.addRecord(rec); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: "store", message: String(e) }); }
});

/* ---------- 已完成 Session 的教師答案（供學員端在進入下一站時，併入累積病歷）---------- */
app.get("/api/case-answer", async (req, res) => {
  const s = Number(req.query.session);
  if (!(s >= 1 && s <= 4)) return res.status(400).json({ error: "bad_session" });
  try {
    const ans = await store.getTeacherAnswers();
    res.json({ session: s, text: String((ans && ans[s]) || "") });
  } catch (e) { res.status(500).json({ error: "store" }); }
});

/* ---------- 健康檢查 ---------- */
app.get("/api/health", (req, res) =>
  res.json({ ok: true, build: BUILD, model: MODEL, fallback: (process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite").trim(), thinking: (process.env.GEMINI_THINKING || "low").trim().toLowerCase(), hasKey: !!API_KEY, storage: store.usingRedis() ? "key-value" : "local-file" }));

// 立刻啟動伺服器，不等 Key Value（避免 Key Value 設定問題卡住整個網站）；
// Key Value 在背景連線，連上後續操作就會自動改用 Key Value
app.listen(PORT, () => {
  console.log(`\n  AI 臨床推理模擬訓練平台執行中（build ${BUILD}）`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  模型：${MODEL}　API key：${API_KEY ? "已設定" : "未設定（AI 功能無法使用）"}`);
});
store.ready().then(() => {
  console.log(`  儲存：${store.usingRedis() ? "Render Key Value" : "本機檔案"}\n`);
});
