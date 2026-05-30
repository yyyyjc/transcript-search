# 逐字稿語料庫語意檢索

> 競選團隊媒體組內部工具・對候選人歷年逐字稿（記者會、節目、受訪）做主題式語意檢索

**🌐 線上版**：https://yyyyjc.github.io/transcript-search/

---

## 這是什麼

媒體組常常需要回顧候選人「之前對某議題講過什麼」——這以前要翻整個 Drive 資料夾。本工具讓你輸入一個主題（如「變電所」），自動：

1. 掃過兩個 Drive 資料夾的所有逐字稿
2. 找出包含該主題的段落
3. 用 Claude 判斷哪些段落「真的在語意上相關」（不是字面湊巧出現）
4. 為相關段落生成一句摘要

回傳一張一張卡片：日期、場合、AI 摘要、原文（高亮）、Drive 連結、可複製、可匯出 CSV。

---

## 使用者快速上手

要實際用工具的媒體組成員 → 看 [USER_GUIDE.md](USER_GUIDE.md)

---

## 架構

```
媒體組成員瀏覽器
  │  ① Google 登入（OAuth，drive.readonly scope）
  ▼
[A] GitHub Pages 前端（index.html，單檔）
  │  - Google Identity Services
  │  - 列檔 / 讀檔 / 粗篩 / 高亮 / 成本顯示
  ├──② OAuth token 直讀 Drive 兩個資料夾──► Google Drive（Shared Drive）
  └──③ 候選段落 + 查詢 POST───────────────► [C] Cloudflare Worker
                                                │  - 反查 Drive 確認使用者有權限
                                                │  - IP rate limit
                                                │  - 呼叫 Claude API
                                                ▼
                                              Anthropic Claude API
```

**設計原則**：使用者身份留在 Google（OAuth token 短期、僅該人權限）；AI 金鑰只進 Cloudflare Worker secret，永不進前端。

---

## 版本路線

- **v1.0 精確搜尋**（已上線）：粗篩用查詢字面，媒體組需下精準關鍵字
- **v2.0 廣義搜尋**（規劃中）：Claude 自動發散相關詞再粗篩；UI 加切換鈕

詳見 [SPEC.md §13](SPEC.md)。

---

## 技術棧

| 層 | 技術 |
|---|---|
| 前端 | 單檔 HTML + vanilla JS（無 build chain） |
| 登入 | Google Identity Services（drive.readonly） |
| .docx 解析 | mammoth.js（CDN） |
| 後端 | Cloudflare Workers |
| AI | Anthropic Claude（claude-sonnet-4-6） |
| 儲存 | Google Drive（Shared Drive） |
| 託管 | GitHub Pages |

---

## 給開發者 / 維運者

### 倉庫結構

```
.
├── index.html              # 前端單檔（HTML + CSS + JS）
├── README.md               # 本檔
├── USER_GUIDE.md           # 媒體組使用指南
├── SPEC.md                 # 🔑 規格單一真相來源
├── SETUP.md                # 帳號 / 金鑰 / 部署步驟
├── chat_to_code_HANDOFF.md # 設計脈絡（歷史檔，已凍結）
├── spec-review.html        # SPEC 互動審查工具（內部用）
└── worker/
    ├── worker.js           # Cloudflare Worker 主程式
    ├── wrangler.toml       # 部署設定
    └── package.json        # wrangler 依賴
```

### 本機開發

```bash
# 前端（靜態檔）
cd /path/to/repo
python3 -m http.server 8000     # 或任何 static server
# → http://localhost:8000
# ⚠️ port 需在 Google OAuth 「已授權的 JavaScript 來源」白名單

# Worker 本機 dev
cd worker/
npx wrangler dev
```

### 部署

```bash
# Worker（每次改 worker.js 或 wrangler.toml 後）
cd worker/
npx wrangler deploy

# 前端（每次改 index.html 後）
git add index.html
git commit -m "..."
git push        # GitHub Pages 自動部署，約 1-2 分鐘生效
```

### 加新成員

完全靠 Drive 控管：
1. 把成員 email 加進兩個 Drive 資料夾的分享名單（檢視者即可）
2. **內部模式**已涵蓋整個 Workspace 組織，不需要動 Google Cloud Console
3. 媒體組成員第一次登入會看到 OAuth 同意畫面（內部模式無「未驗證」警告）

### 移除成員

從 Drive 資料夾分享名單移除即可，不必動程式。Worker 反查 Drive 會自動拒絕。

### 更新 Claude model

當 Anthropic 出新模型，或現有 model 即將退役時：
1. 編輯 `worker/worker.js` 第 17 行 `MODEL` 常數
2. 編輯 `index.html` 中 `PRICE_INPUT_PER_M` / `PRICE_OUTPUT_PER_M` 對應新模型計價
3. `cd worker && npx wrangler deploy`
4. `git add -A && git commit -m "model: switch to claude-xxx" && git push`

---

## 安全模型

- **OAuth scope 僅 `drive.readonly`** — 工具無法寫入、刪除、修改任何 Drive 內容
- **Anthropic API key** 只存於 Cloudflare Worker secret（`wrangler secret put ANTHROPIC_API_KEY`），永不進前端 / git
- **權限控管** 完全交給 Drive 既有分享名單；不自建白名單。Worker 收到請求時會拿使用者 token 反查 Drive 確認權限
- **IP rate limit** 20 req/min/IP 防止 Worker URL 外洩後被當免費 Claude proxy

詳見 [SPEC.md §7](SPEC.md) Boundaries。

---

## 隱私

逐字稿內容會在搜尋時送 Anthropic Claude API 做分析。依 Anthropic 政策，企業 API 用戶請求預設**不用於模型訓練**。本工具不在伺服器端保存任何逐字稿、查詢、結果——瀏覽器 localStorage 僅保存「今日累計成本」此小資料。

---

## License

本專案為內部工具，未對外授權。如有興趣討論架構或借鏡實作，請洽工具維運者。
