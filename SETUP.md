# SETUP — 取得 OPEN INPUTS 的逐步指引

> 給使用者本人照做。這些步驟涉及帳號與金鑰，**Claude 不能代為操作**。每完成一段請把產出值貼回對話視窗，Claude 會幫你寫進 `index.html`、`wrangler.toml`、Worker secret。

---

## 進度概覽

| # | 要做 | 產出物 | 狀態 |
|---|---|---|---|
| 0 | Drive 資料夾 ID | `DRIVE_FOLDERS` | ✅ 已取得 |
| 1 | Google Cloud Console 建 OAuth Client ID | `GOOGLE_OAUTH_CLIENT_ID` | ✅ **已取得（內部模式）** |
| 2 | Anthropic API Key | （只給 Cloudflare，不外流） | ✅ **已完成** |
| 3 | Cloudflare Workers 部署 | `WORKER_URL` | ✅ **已完成** |
| 4 | GitHub Pages 部署 | `GITHUB_PAGES_URL` | ⬜ |
| 5 | 回頭把 Pages URL 填進 Google OAuth 授權來源 | — | ⬜ |

> Worker URL：`https://transcript-search.happiny-cloudflare.workers.dev`  
> Sanity test：無 token → 401 missing_token；假 token → 401 token_invalid；OPTIONS → 204 ✅

---

## Phase 1 — Google Cloud Console ✅ 已完成

> 完成日期：2026-05-26  
> 採用「內部」User Type（pumashen.org Workspace 組織）  
> 產出：`GOOGLE_OAUTH_CLIENT_ID = 238899236530-s6bqtibgjm7407ds4ogp35dp1ph36tr6.apps.googleusercontent.com`

**目的**：讓網頁能用 Google 帳號登入並讀 Drive。

### 1.1 建 GCP 專案
1. 開 https://console.cloud.google.com/
2. **左上角組織選擇器**確認選到「pumashen.org」（不是「沒有組織」）
3. 頂端專案下拉 → 「新增專案」
4. 專案名稱：`transcript-search`（隨意）→ 建立

### 1.2 啟用 Drive API
1. 左側選單 → 「API 和服務」→ 「程式庫」
2. 搜尋 `Google Drive API` → 點進去 → 「啟用」

### 1.3 設定 OAuth 同意畫面
1. 左側選單 → 「API 和服務」→ 「OAuth 同意畫面」
2. **User Type 選「內部」**（pumashen.org 全組織帳號自動允許；不必維護測試使用者名單）
   - 如果你不在 Workspace 組織或專案不在組織下，「內部」會灰掉 → 改選「外部」並參考下方 1.3a
3. 應用程式名稱：`逐字稿語料庫檢索`
4. 使用者支援電子郵件 + 開發人員聯絡：你自己的 email
5. 範圍跳過 → 下一步 → 完成

### 1.3a 若被迫用「外部」（fallback）
- User Type 選「外部」→ 建立
- **測試使用者**：手動加所有媒體組成員 email（最多 100 人）
- 注意：使用者登入時會看到「未驗證應用程式」警告，需點「進階」才能進

### 1.4 建立 OAuth Client ID
1. 左側選單 → 「API 和服務」→ 「憑證」
2. 上方「+ 建立憑證」→ 「OAuth 用戶端 ID」
3. 應用程式類型：**「網頁應用程式」**
4. 名稱：`transcript-search-web`
5. **已授權的 JavaScript 來源**：先填 `http://localhost:8000`（本地測試用），之後拿到 GitHub Pages 網址再回來加一條（例如 `https://你的帳號.github.io`）
6. **已授權的重新導向 URI**：可留空（我們用 Implicit / Token flow，不需要）
7. 建立 → 跳出視窗顯示「用戶端 ID」（像 `123456789-xxxxxxxxxxxx.apps.googleusercontent.com`）

### 📤 給 Claude 的值
- `GOOGLE_OAUTH_CLIENT_ID` = 上面那串 `xxx.apps.googleusercontent.com`

---

## Phase 2 — Anthropic API Key

**目的**：給 Cloudflare Worker 用來呼叫 Claude。

1. 開 https://console.anthropic.com/
2. 左側 `API Keys` → `Create Key`
3. 命名：`transcript-search-worker`
4. 複製金鑰（**只會顯示一次**，請存起來，例如貼到密碼管理器）
5. 在 Billing 充值或確認有額度

### 📤 不要貼給 Claude
這把金鑰只會在 **Phase 3** 透過 `wrangler secret put` 直接交給 Cloudflare，**不要貼進對話、不要寫進任何檔案、不要 commit 進 Git**。

---

## Phase 3 — Cloudflare Worker 部署

**目的**：建立一個只負責呼叫 Claude 的薄代理服務。

### 3.1 註冊 Cloudflare
1. 開 https://dash.cloudflare.com/sign-up 註冊
2. Email 驗證完成

### 3.2 安裝 wrangler（Cloudflare CLI）
打開終端機，執行（macOS 用 npm）：
```bash
# 確認 Node.js 已安裝
node -v   # 需要 >= 18

# 安裝 wrangler（全域）
npm install -g wrangler

# 登入 Cloudflare（會開瀏覽器授權）
wrangler login
```

### 3.3 部署 Worker
Claude 會在 `/worker/` 目錄產出三個檔案：
- `worker/worker.js` — Worker 主程式
- `worker/wrangler.toml` — 部署設定
- `worker/package.json` — 相依套件

部署步驟：
```bash
cd worker/
npm install          # 裝相依
wrangler secret put ANTHROPIC_API_KEY
# ↑ 會問你 secret 值，貼上 Phase 2 拿到的 Anthropic API Key
wrangler deploy      # 部署
```

> **註**：Worker 不維護獨立的 email 白名單。權限完全委派給 Google Drive — Worker 收到請求時會拿你的 token 反問 Drive「能看到資料夾嗎」，看得到才放行。詳見 [SPEC.md §9.2](SPEC.md)。

部署成功後 wrangler 會印出 URL，像 `https://transcript-search.你的帳號.workers.dev`

### 📤 給 Claude 的值
- `WORKER_URL` = 上面那串 `https://xxx.workers.dev`

---

## Phase 4 — GitHub Pages 部署

**目的**：把 `index.html` 公開成網頁，讓媒體組可用。

### 4.1 建 GitHub Repo
1. 開 https://github.com/new
2. Repo 名稱：`transcript-search`（隨意，但會出現在公開網址）
3. Public（Private repo 也能開 Pages，但要 Pro 帳號）
4. 不要勾 README，建立

### 4.2 上傳檔案
方法 A（網頁 UI 拖拉，最簡單）：
- 進 repo → `Add file` → `Upload files` → 拖入 `index.html` → Commit

方法 B（用 git CLI）：
```bash
cd /Users/ailala/Documents/Claude/Projects/逐字稿檢索/
git init
git add index.html
git commit -m "init"
git branch -M main
git remote add origin https://github.com/你的帳號/transcript-search.git
git push -u origin main
```

### 4.3 啟用 Pages
1. Repo → `Settings` → 左側 `Pages`
2. Source 選 `Deploy from a branch`
3. Branch 選 `main` / `/ (root)` → Save
4. 等 30 秒～1 分鐘，頁面上方會出現 `Your site is live at https://你的帳號.github.io/transcript-search/`

### 📤 給 Claude 的值
- `GITHUB_PAGES_URL` = 上面那串 `https://你的帳號.github.io/transcript-search/`

---

## Phase 5 — 把 Pages URL 加回 Google OAuth 授權來源

剛拿到的 GitHub Pages URL 必須加回 Phase 1 的設定，否則 Google 會拒絕登入。

1. 回到 https://console.cloud.google.com/
2. 「API 和服務」→ 「憑證」→ 點開 `transcript-search-web` 那筆 OAuth Client ID
3. **已授權的 JavaScript 來源** 新增一條：你的 Pages 網域（注意：**只到網域**，不要含路徑。例如填 `https://你的帳號.github.io`，不是 `https://你的帳號.github.io/transcript-search/`）
4. 儲存（變更需要 5 分鐘～數小時生效）

---

## Phase 6 — Drive 資料夾分享名單檢查

確認以下兩個資料夾**對所有媒體組成員都已分享**（檢視者權限即可）：
- 受訪備份：https://drive.google.com/drive/folders/1T797mtvd52IYEad1up2MjJV-5w3GLoaC
- 節目備份：https://drive.google.com/drive/folders/1mB-xrRe9jb4AiAg22XABmg9rzP1JYIxq

每位使用者用自己帳號登入後，Drive 會自動檢查他是否在分享名單。沒被加 → 看不到檔案 → 工具會顯示「無權限或資料夾為空」。

---

## 完成檢核表

回填以下值給 Claude 後即可進入真實串接：

```
DRIVE_FOLDERS = { 受訪: 1T797mtvd52IYEad1up2MjJV-5w3GLoaC, 節目: 1mB-xrRe9jb4AiAg22XABmg9rzP1JYIxq }  ✅
GOOGLE_OAUTH_CLIENT_ID = _______________________
WORKER_URL              = _______________________
GITHUB_PAGES_URL        = _______________________
```

Anthropic API Key 不需給 Claude，已透過 `wrangler secret put` 進 Cloudflare。
