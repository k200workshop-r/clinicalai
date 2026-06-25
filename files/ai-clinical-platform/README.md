# AI 臨床推理模擬訓練平台（Gemini 版）

供住院醫師教學使用的網頁平台：4 個 Session 的臨床推理模擬、共用 3 點「生命點數」的 AI 建議、累積病歷時間軸、教師後台（標準答案保存於伺服器、不外洩給學員）、各組紀錄與 PDF 下載。

這是一個**可獨立部署**的版本：前端是純網頁，後端是輕量的 Node 伺服器，負責保管 API key、轉發 AI 請求，並把教師答案與各組紀錄存在伺服器端。AI 使用 **Google Gemini 2.5 Flash**，搭配 **Google AI Studio** 的 API key。

---

## 一、需要先準備

1. **Node.js 18 以上**（含內建 `fetch`）。到 https://nodejs.org 下載安裝。
2. **Google AI Studio API key**：到 https://aistudio.google.com/apikey 點幾下就能建立（金鑰以 `AIza` 開頭）。

> 費用：Gemini 2.5 Flash 在 Google AI Studio 有**免費額度**（有每分鐘/每日請求數限制），一般課堂使用通常免費就夠。若超出免費額度而升級為付費，2.5 Flash 仍屬低價等級。額度與計費以 Google 官方為準：https://ai.google.dev/pricing

---

## 二、在自己電腦上跑起來（本機測試）

```bash
# 1. 進入專案資料夾
cd ai-clinical-platform

# 2. 安裝套件
npm install

# 3. 建立設定檔，把 .env.example 複製成 .env
cp .env.example .env        # Windows 用 copy .env.example .env

# 4. 編輯 .env，至少填入：
#    GEMINI_API_KEY=AIza你的金鑰
#    TEACHER_PASSCODE=你自己的密碼

# 5. 啟動
npm start
```

啟動後打開瀏覽器到 **http://localhost:3000** 即可使用。
教師後台在右上角「教師後台」，用你在 `.env` 設定的 `TEACHER_PASSCODE` 登入。

---

## 三、部署到雲端，讓住院醫師隨時可用

讓人人都能透過網址連線，需要把它放到一個 24 小時運行的主機上。以下任選一種。

### 選項 A：Render（最簡單，適合非工程背景）

1. 把專案放到一個 GitHub repo。GitHub 網頁那個「choose your files」按鈕只能選單檔，所以**用拖曳的方式**上傳整個資料夾。任選一種：

   **方法一：網頁拖放（最快）**
   - 先把下載的 zip 解壓縮，得到 `ai-clinical-platform` 資料夾。
   - 在 GitHub 點右上角 **＋ → New repository**，取個名字後建立。
   - 進到該 repo 頁面，點 **Add file → Upload files**。
   - 打開電腦的檔案總管，把 `ai-clinical-platform` 資料夾**裡面的所有檔案與子資料夾**（`server.js`、`package.json`、`public`、`README.md` 等）全部選起來，直接**拖曳**到網頁中央的上傳區。GitHub 會自動保留 `public/` 等子資料夾的結構。
   - 拉到最下面點 **Commit changes** 完成。
   - 小提醒：請把資料夾「裡面的內容」拖上去，讓 `package.json` 位在 repo 的最上層（這樣 Render 才找得到）。若你是把整個 `ai-clinical-platform` 資料夾拖上去、變成 repo 裡的子資料夾，等下在 Render 要把 **Root Directory** 設成 `ai-clinical-platform`。

   **方法二：GitHub Desktop（日後要更新比較方便）**
   - 安裝 GitHub Desktop → **File → Add local repository**，選解壓後的資料夾（或先 New repository 再把檔案放進去）。
   - 按 **Commit**，再按 **Publish repository** 即可整包推上 GitHub，之後改東西也只要 Commit + Push。

   安全提醒：本專案內**沒有** `.env`（金鑰是之後直接填到 Render 的環境變數，不放進 repo），所以不會外洩；請不要自行建立 `.env` 後又把它拖上去。
2. 到 https://render.com 註冊，點 **New → Web Service**，連到該 repo。
3. 設定：
   - **Build Command**：`npm install`
   - **Start Command**：`node server.js`
4. 在 **Environment** 加入環境變數：
   - `GEMINI_API_KEY` = 你的 Google AI Studio 金鑰
   - `TEACHER_PASSCODE` = 你的密碼
   - （可選）`GEMINI_MODEL`、`PORT`
5. 部署完成後，Render 會給你一個 `https://xxx.onrender.com` 的網址，分享給學員即可。Render 自動提供 HTTPS。

### 選項 B：Railway / Fly.io / 醫院內部伺服器

同樣是「Node 18 + `npm install` + `node server.js` + 設定環境變數」。在醫院內網主機上，可用 `pm2` 常駐執行（`npm i -g pm2 && pm2 start server.js`）。

### 各組紀錄的保存：接上 Render Key Value（建議）

預設情況下，若沒有設定 `REDIS_URL`，紀錄會存在伺服器本機檔案（`data/store.json`），而 Render 免費 Web Service 的檔案系統是暫時的——**重新部署或休眠後就會被清空**。為了讓各組紀錄不被網站重新部署／休眠清掉，請接上一個獨立的 **Render Key Value（Redis）**：

1. 在 Render 點 **New → Key Value**（或開 https://dashboard.render.com/new/redis ）。
2. 設定：名稱隨意；**Region 要和你的 Web Service 相同**（才能用內部網路連線）；Plan 選 **Free**；Maxmemory Policy 建議選 **noeviction**（避免紀錄被自動淘汰）。建立。
3. 進入該 Key Value 的頁面，在 **Connect** 找到 **Internal Key Value URL**（`redis://...`），複製起來。
4. 回到你的 **Web Service → Environment**，新增環境變數：`REDIS_URL` = 剛剛複製的內部網址。儲存後 Render 會自動重新部署。
5. 部署完成後，開 `你的網址/api/health`，看到 `"storage":"key-value"` 就代表已接上。

接上之後：你**重新部署網站、或網站休眠**都不會再清掉各組紀錄。

**仍要知道的限制**：Render「免費」Key Value 不寫入磁碟，當 **Key Value 本身重啟或維護**時資料仍會清空，Render 可能隨時進行；因此它適合「上課當下彙整各組答案」，**永久存檔請以老師下載的 PDF 為準**。若要真正永久保存，需升級為付費 Key Value（含磁碟持久化），或改用資料庫方案（Render 免費 Postgres 會在建立 30 天後刪除，不適合長期）。需要我幫你改成付費 KV 或 Postgres 寫法再告訴我。

---

## 四、安全與隱私

- **API key 只存在伺服器**（`.env` / 環境變數），永遠不會出現在學員瀏覽器，請勿把 `.env` 上傳到公開 repo。
- **教師標準答案存在伺服器**，只有用密碼登入換到 token 後才會回傳，學員端完全拿不到。
- 請務必把 `TEACHER_PASSCODE` 改成自己的強密碼。
- 本平台僅供**虛構教學個案**模擬使用，請勿輸入任何真實病人的可識別資訊。
- Gemini 金鑰若外洩，他人可消耗你的配額並產生費用；請比照密碼妥善保管。

---

## 五、自訂

- **換個案**：修改 `public/index.html` 最上方的 `CASE_BASE`。
- **改時間**：同檔案的 `ANSWER_SECONDS`（作答秒數）、`FEEDBACK_SECONDS`（回饋秒數）。
- **改 Session 內容 / AI 任務描述**：在 `public/index.html` 的 `SESS` 物件與 `useAI()`、`generateS4()` 內的 prompt。
- **換模型**：在 `.env` 設定 `GEMINI_MODEL`（例如 `gemini-2.5-flash-lite` 更省、`gemini-2.5-pro` 更強）。

---

## 六、技術備註

- 後端呼叫的端點：`POST https://generativelanguage.googleapis.com/v1beta/models/<模型>:generateContent`，以 `x-goog-api-key` 標頭帶入金鑰。
- 系統指令放在 `system_instruction`，使用者內容放在 `contents`，回應取自 `candidates[0].content.parts`。
- Gemini 2.5 Flash 預設啟用「思考」，會佔用輸出額度；後端已把 `maxOutputTokens` 設為 2048 以避免回傳空字串。
- 安全設定放寬為 `BLOCK_ONLY_HIGH`，降低臨床教學文字被誤擋的機率。

---

## 七、PDF 下載

平台不做自動上傳，也不需要任何雲端設定。老師在學員總結頁或教師後台按「下載 PDF」／「下載全部（合併 PDF）」，檔案就會以瀏覽器的方式存到電腦的「下載」資料夾，檔名為 `AI臨床訓練_組別.pdf`。

---

## 檔案結構

```
ai-clinical-platform/
├─ server.js          後端：靜態網站 + Gemini AI 代理 + 紀錄/答案 API
├─ package.json
├─ .env.example       設定範本（複製為 .env 使用）
├─ .gitignore
├─ public/
│  └─ index.html      前端（整個平台介面）
└─ data/
   └─ store.json      自動產生：教師答案與各組紀錄
```
