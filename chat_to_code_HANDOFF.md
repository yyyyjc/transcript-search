# 交接文件：逐字稿語料庫語意檢索網頁

> 給接手的 coding agent：本文件是完整規格。讀完即可開工，無需再向使用者確認架構決策（已定案）。需要使用者提供的具體值，集中列在最後的「OPEN INPUTS」區，缺值處用 `<<...>>` 標記。

---

## 1. WHAT YOU ARE BUILDING

一個讓政治競選團隊「媒體組」使用的網頁工具。媒體組把候選人的逐字稿（記者會、政論節目等）存放在一個共用的 Google Drive 資料夾。本工具讓使用者輸入一個**主題**（例如「變電所」），對整個資料夾做**語意檢索**，找出候選人講過該主題的所有段落，並列出每一筆的：**日期、場合、命中的原文段落、一句 AI 摘要**。

關鍵：這不是「貼一篇逐字稿做摘要」的工具，而是「對一整個歷史語料庫做語意檢索」的工具。檢索是主功能，摘要是附屬。

### Primary user story
> 媒體組成員打開網頁 → Google 登入 → 輸入「變電所」→ 看到候選人歷來所有提到電力/能源/高壓電/台電的發言，每筆含日期、場合、原文、摘要 → 一鍵複製或匯出。

---

## 2. ARCHITECTURE (DECIDED — DO NOT REDESIGN)

三個元件，職責隔離。設計原則：**敏感物件各待其所——使用者身份留在 Google，AI 金鑰留在後端，前端不持有任何長期秘密。**

```
Browser (媒體組成員)
  │  ① Google 登入 (OAuth, 模式 A: 每人用自己帳號)
  ▼
[A] GitHub Pages 前端 (公開靜態託管, 零成本)
  │   - Google 登入 UI
  │   - 輸入主題 / 顯示結果 / 複製 / 匯出
  │   - 用「使用者本人身份」直接讀 Drive
  ├──② 帶 user OAuth token 直接讀 Drive────────────► Google Drive 資料夾
  └──③ 把候選逐字稿文字 + 查詢送去做語意檢索──► [C] Cloudflare Worker 後端
                                                      │ - 唯一持有 Claude API key
                                                      │ - 收文字 → 呼叫 Claude → 回結果
                                                      ▼
                                                   Claude API
```

### 為什麼這樣切（給你判斷邊界用）
- **讀 Drive 在前端做，不經後端**：用的是使用者自己的 OAuth token（短期、僅代表本人權限）。放前端安全，因為它只等於使用者本來就有的存取權。
- **呼叫 AI 必須經後端**：Claude API key 是長期、可計費的秘密，絕不可出現在前端（GitHub Pages 原始碼公開可見）。前端只把「要分析的文字」送給 Worker，由 Worker 持金鑰呼叫。

---

## 3. SECURITY MODEL (CRITICAL — 權限控管的核心)

採 **模式 A（per-user OAuth）**。權限控管**完全委派給 Google Drive 既有的資料夾分享設定**，本工具不自建任何白名單邏輯。

- 網頁公開：任何人都能打開、都能用任意 Google 帳號登入成功。
- **登入成功 ≠ 能用**：前端帶使用者身份讀 Drive 資料夾時，Google 自動檢查該帳號是否在資料夾分享名單內。在 → 讀得到逐字稿；不在 → Google 回絕，前端拿到空結果。
- 這道權限關卡由 **Google 把守，不是本程式把守**。不要寫任何「檢查使用者是否為媒體組」的程式邏輯——多餘且會引入 bug。
- 既定事實：該資料夾本來就對全媒體組可見，所以媒體組成員登入後都能用。

### 不可違反的安全約束（hard constraints）
1. **Claude API key 永遠不得出現在前端程式碼、不得 commit 進 repo**。只能放 Cloudflare Worker 的環境變數（secret）。
2. Google OAuth **Client ID 可以**放前端（它本來就是公開識別碼，非秘密）。
3. Drive 存取一律 **唯讀 scope**（`drive.readonly`），絕不要求寫入權限。
4. 不要實作任何檔案下載、刪除、修改、分享權限變更功能。本工具純讀取 + 顯示。
5. Worker 端**應**驗證進來的請求帶有效的 Google token 才處理（防止他人發現 Worker 網址後白嫖 API 金鑰）。第一版可先做基本驗證，但不可完全省略。

---

## 4. COMPONENT SPEC

### [A] 前端 (GitHub Pages)
- 單頁應用。技術選型自由，但**偏好單一 HTML 檔內含 JS**（最易部署到 GitHub Pages、最易維護）。可用原生 JS 或輕量框架，避免重型 build chain。
- 使用 Google Identity Services (GIS) 做 OAuth；scope 僅 `https://www.googleapis.com/auth/drive.readonly`。
- 用 Google Drive API v3 列出目標資料夾內檔案、讀取檔案內容。
- 檔案型態：純文字 `.txt` 與 Google Docs（`application/vnd.google-apps.document`，需用 export 取純文字）。
- UI 需求：
  - Google 登入 / 登出按鈕，顯示目前登入者 email。
  - 主題輸入框 + 檢索按鈕。
  - 結果區：每筆命中一張卡片，含「日期 | 場合 | 原文段落 | AI 摘要」，每張卡片可一鍵複製；整批結果可匯出（複製全部 / 下載 .md 或 .csv）。
  - 載入中、無結果、權限不足（讀不到資料夾）、錯誤等狀態都要有明確提示。

### [B] Google Drive 資料夾
- 由 OPEN INPUTS 提供 folder ID。程式中以常數寫死該 folder ID，使用者無法在 UI 改成查別的資料夾（範圍鎖定）。
- 檔名格式（既定）：日期與場合寫在檔名，形如 `1140520_記者會`。
  - `1140520` = 民國日期（民國 114 年 5 月 20 日 = 西元 2025-05-20）。**注意是民國年，需轉換**。
  - 底線後為場合（記者會 / 政論節目 / 質詢 等）。
  - 解析需容錯：並非每個檔名都嚴格守規，解析失敗時 fallback 顯示原始檔名，不要 crash。

### [C] Cloudflare Worker 後端
- 極薄代理。單一職責：收前端送來的 `{ transcripts, query }` → 組 prompt → 呼叫 Claude API → 回傳結構化結果。
- Claude API key 存於 Worker secret（`wrangler secret put`），不寫入程式碼。
- 部署用 `wrangler`。提供 `wrangler.toml` 與部署步驟。
- 驗證進來請求的 Google token 有效性（呼叫 Google tokeninfo endpoint 或驗證 JWT）後才處理。
- 回傳格式：JSON array，每元素 `{ date, occasion, excerpt, summary, source_filename }`。讓前端直接 render。

---

## 5. 語意檢索實作策略 (兩段式：粗篩 + 精篩)

逐字稿可能很多、很長，不可一次全塞給 Claude（超 context 上限、費用高）。採兩段：

1. **粗篩（前端，無 AI）**：使用者輸入主題後，先用「擴展關鍵字」在各檔案內文做字面比對，挑出可能相關的檔案/段落。建一張主題→同義詞表（如 `變電所 → [變電所, 電力, 能源, 高壓電, 台電, 供電, 電網]`），可先寫死常用議題，亦可由 Claude 在精篩階段補語意。
2. **精篩（後端 + Claude）**：把粗篩命中的段落連同原查詢送 Worker → Claude，請它判斷真正語意相關者、抽出精確段落、生成摘要、回結構化 JSON。

此設計讓「真語意理解」只作用在小範圍候選內容上，兼顧準度、速度、成本。粗篩同義詞表不需完美——它只負責「不要漏」，精篩負責「去誤判」。

---

## 6. CLAUDE API 呼叫規格 (Worker 內)

- Endpoint: `https://api.anthropic.com/v1/messages`
- 建議 model: 用當前可用的 Claude 模型字串（接手時請向使用者確認或查 docs.claude.com 取最新 model id；勿沿用可能過期的字串）。
- System prompt 要點（用中文，台灣用語）：
  - 角色：協助政治幕僚從逐字稿語料中檢索特定議題的歷史發言。
  - 任務：給定多段逐字稿與一個查詢主題，找出**語意相關**（非僅字面相符）的段落。
  - 輸出：**只回 JSON array**，無前言、無 markdown 圍欄。每元素含 `date / occasion / excerpt / summary / source_filename`。`excerpt` 為原文（不改寫），`summary` 為一句話中文摘要。
  - 找不到相關段落時回空 array `[]`。
- Worker 需安全解析回應：抓 `data.content` 中 `type==="text"` 區塊，去除可能的 ```json 圍欄再 `JSON.parse`，包 try/catch。

---

## 7. BUILD ORDER (建議施工順序)

1. 先做 [C] Worker + 一個寫死的假逐字稿，確認能呼叫 Claude 並回正確 JSON。（隔離驗證 AI 那段）
2. 做 [A] 前端的 Google 登入，確認能登入並列出資料夾檔案、讀到內文。（隔離驗證 Drive 那段）
3. 串接：前端粗篩 → 送 Worker → 顯示結果。
4. 補 UI 狀態、檔名解析（民國年轉換）、複製/匯出。
5. 補 Worker 的 token 驗證鎖。

每步可獨立驗證，避免一次全串接後難以定位問題。

---

## 8. SETUP STEPS THE HUMAN MUST DO (你需指引使用者完成；非你能代勞)

這些涉及帳號與金鑰，**必須由使用者本人操作**，agent 不得代為建立帳號或輸入金鑰：

1. **Google Cloud Console**：建專案 → 啟用 Drive API → 建 OAuth Client ID（類型：網頁應用程式）→ 「已授權的 JavaScript 來源」填 GitHub Pages 網址 → 取得 Client ID 交給前端。OAuth 同意畫面初為測試模式，把媒體組成員 email 加進「測試使用者」名單即可用（內部小團隊最省事，免送 Google 審）。
2. **Cloudflare**：註冊帳號 → 安裝 wrangler → `wrangler secret put ANTHROPIC_API_KEY` 輸入自己的 Claude API 金鑰 → `wrangler deploy`。
3. **GitHub**：建 repo → 放前端檔 → 開啟 GitHub Pages。
4. 提供逐字稿資料夾的 **folder ID**。

> Agent：遇到上述步驟，產出清楚的逐步指引讓使用者照做，並等待他回填 OPEN INPUTS 的值，**不要嘗試自動化建立帳號 / 代填金鑰**。

---

## 9. COST NOTE
GitHub Pages 免費；Cloudflare Workers 免費額度內免費；唯一計費是 Claude API 用量，由使用者那組金鑰承擔（低頻議題查詢，量級通常每月數美元內）。實作上的兩段式粗篩正是為了壓低送進 AI 的 token 量。

---

## 10. OPEN INPUTS (使用者需回填；缺則先以佔位值開發)

- `DRIVE_FOLDER_ID` = `<<尚未取得，使用者需向媒體組確認資料夾位置後提供>>`
- `GOOGLE_OAUTH_CLIENT_ID` = `<<使用者於 Google Cloud Console 建立後提供>>`
- `WORKER_URL` = `<<Cloudflare 部署後產生>>`
- `GITHUB_PAGES_URL` = `<<建 repo 開 Pages 後產生；需回填進 Google OAuth 授權來源>>`
- `ANTHROPIC_MODEL_ID` = `<<接手時確認當前可用 model 字串>>`
- 候選人姓名 / 常見議題清單（用於粗篩同義詞表初始化）= `<<可選，使用者提供能提升粗篩品質>>`

---

## 11. OUT OF SCOPE (本版不做，勿擅自加)
- 不做使用者白名單 / 角色管理（權限交給 Drive）。
- 不做檔案上傳 / 編輯 / 刪除 / 分享設定。
- 不做資料庫（結果即時運算，不持久化；逐字稿本身已存在 Drive）。
- 不把 AI 金鑰放前端。
- 不處理影音檔轉逐字稿（既定：資料夾內已是純文字/Google Docs）。
