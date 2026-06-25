/* 儲存層
 * - 線上：若設定了 REDIS_URL（Render Key Value 的內部連線網址），就把資料存進 Key Value。
 *   Key Value 是獨立服務，網站重新部署或休眠都不會清掉它。
 * - 本機開發：沒有 REDIS_URL 時，自動退回 data/store.json，免設定即可測試。
 *
 * 注意：Render「免費」Key Value 不寫入磁碟，若該實例重啟／維護仍會清空；
 *      永久存檔請以老師下載的 PDF 為準。
 */
const fs = require("fs");
const path = require("path");

const REDIS_URL = process.env.REDIS_URL || process.env.KEY_VALUE_URL || "";
const K_ANS = "clinic:teacherAnswers";
const K_REC = "clinic:recmap"; // 以「組別」為鍵的覆蓋式儲存（同組會更新，不重複）

let client = null;
let readyPromise = Promise.resolve(false);

if (REDIS_URL) {
  try {
    const { createClient } = require("redis");
    const c = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 8000,
        // 重試數次仍失敗就放棄（回傳 Error 讓 connect() reject），避免無限卡住
        reconnectStrategy: (retries) =>
          retries > 3 ? new Error("Key Value 連線重試過多，停止重試") : Math.min(retries * 500, 2000),
      },
    });
    c.on("error", (e) => console.error("Key Value 連線錯誤：", e.message));
    readyPromise = c
      .connect()
      .then(() => {
        client = c;
        console.log("已連上 Render Key Value，各組紀錄將存於 Key Value");
        return true;
      })
      .catch((e) => {
        console.error("Key Value 連線失敗，改用本機檔案：", e.message);
        client = null;
        return false;
      });
  } catch (e) {
    console.error("無法載入 redis 套件，改用本機檔案：", e.message);
  }
}

/* ---- 本機檔案備援 ---- */
const FILE = path.join(process.cwd(), "data", "store.json");
function readLocal() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch (e) { return { teacherAnswers: { 1: "", 2: "", 3: "", 4: "" }, records: [] }; }
}
function writeLocal(d) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }
  catch (e) { console.error("寫入本機 store 失敗：", e.message); }
}

/* ---- 對外 API（皆為 async）---- */
async function getTeacherAnswers() {
  if (client) {
    const v = await client.get(K_ANS);
    return v ? JSON.parse(v) : { 1: "", 2: "", 3: "", 4: "" };
  }
  return readLocal().teacherAnswers;
}
async function setTeacherAnswer(session, text) {
  if (client) {
    const cur = await getTeacherAnswers();
    cur[session] = text;
    await client.set(K_ANS, JSON.stringify(cur));
    return;
  }
  const d = readLocal();
  d.teacherAnswers[session] = text;
  writeLocal(d);
}
async function addRecord(rec) {
  const group = String((rec && rec.group) || "未命名");
  if (client) {
    await client.hSet(K_REC, group, JSON.stringify(rec)); // 同組覆蓋，不會重複
    return;
  }
  const d = readLocal();
  if (Array.isArray(d.records)) { const o = {}; d.records.forEach((r) => { if (r && r.group) o[r.group] = r; }); d.records = o; }
  if (!d.records || typeof d.records !== "object") d.records = {};
  d.records[group] = rec;
  writeLocal(d);
}
async function getRecords() {
  if (client) {
    const h = await client.hGetAll(K_REC);
    return Object.values(h || {}).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  }
  const d = readLocal();
  if (Array.isArray(d.records)) return d.records;
  return Object.values(d.records || {});
}

async function ready() { return readyPromise; }
function usingRedis() { return !!client; }

module.exports = { getTeacherAnswers, setTeacherAnswer, addRecord, getRecords, ready, usingRedis };
