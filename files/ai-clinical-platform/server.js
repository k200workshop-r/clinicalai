/* AI 臨床推理模擬訓練平台 — 後端伺服器
 * 功能：
 *   1. 提供前端靜態網站（public/）
 *   2. 代理 Google Gemini API（API key 只存在伺服器，不外洩到前端）
 *   3. 伺服器端保存教師標準答案與各組紀錄（data/store.json）
 *   4. 教師後台以密碼登入換取 token，標準答案僅在通過驗證後才回傳
 */
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TEACHER_PASSCODE = process.env.TEACHER_PASSCODE || "teacher2024";
const DATA_DIR = path.join(__dirname, "data");
const STORE = path.join(DATA_DIR, "store.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { teacherAnswers: { 1: "", 2: "", 3: "", 4: "" }, records: [] };
try {
  if (fs.existsSync(STORE)) db = JSON.parse(fs.readFileSync(STORE, "utf8"));
} catch (e) {
  console.error("讀取 store.json 失敗，使用空白資料：", e.message);
}
let saving = false;
function save() {
  // 簡單序列化寫入；課堂規模的並發量足夠安全
  try {
    fs.writeFileSync(STORE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("寫入 store.json 失敗：", e.message);
  }
}

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

/* ---------- AI 代理 ---------- */
app.post("/api/ai", rateLimit, async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "no_key", message: "伺服器尚未設定 GEMINI_API_KEY。" });
  }
  const { system, user } = req.body || {};
  if (!user) return res.status(400).json({ error: "bad_request" });
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
    const payload = {
      contents: [{ role: "user", parts: [{ text: String(user) }] }],
      // maxOutputTokens 設大一些：Gemini 2.5 Flash 預設會「思考」，
      // 思考會消耗輸出額度，留足空間可避免回傳空字串
      generationConfig: { maxOutputTokens: 2048, temperature: 0.4 },
      // 臨床教學文字偶爾會被安全機制誤判，放寬為僅阻擋高風險內容
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
    };
    if (system) payload.system_instruction = { parts: [{ text: String(system) }] };

    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500);
      return res.status(502).json({ error: "upstream", status: r.status, detail });
    }
    const data = await r.json();
    const cand = (data.candidates || [])[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.map((p) => p.text || "").join("").trim()
      : "";
    if (!text) {
      const reason = (cand && cand.finishReason) ||
        (data.promptFeedback && data.promptFeedback.blockReason) || "empty";
      return res.status(502).json({ error: "empty_response", reason });
    }
    res.json({ text });
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
app.get("/api/teacher-answers", teacherAuth, (req, res) => {
  res.json({ answers: db.teacherAnswers });
});
app.post("/api/teacher-answers", teacherAuth, (req, res) => {
  const { session, text } = req.body || {};
  const s = Number(session);
  if (s >= 1 && s <= 4) {
    db.teacherAnswers[s] = String(text || "");
    save();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: "bad_session" });
});

/* ---------- 各組紀錄 ---------- */
app.get("/api/records", teacherAuth, (req, res) => {
  res.json({ records: db.records });
});
app.post("/api/records", (req, res) => {
  const rec = req.body && req.body.record;
  if (rec && rec.group) {
    db.records.push(rec);
    if (db.records.length > 1000) db.records = db.records.slice(-1000);
    save();
    return res.json({ ok: true, count: db.records.length });
  }
  res.status(400).json({ error: "bad_record" });
});

/* ---------- 健康檢查 ---------- */
app.get("/api/health", (req, res) => res.json({ ok: true, model: MODEL, hasKey: !!API_KEY }));

app.listen(PORT, () => {
  console.log(`\n  AI 臨床推理模擬訓練平台執行中`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  模型：${MODEL}　API key：${API_KEY ? "已設定" : "未設定（AI 功能無法使用）"}\n`);
});
