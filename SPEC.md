# SPEC — 逐字稿語料庫語意檢索

> **單一真相來源**。實作以本檔為準。`chat_to_code_HANDOFF.md` 是設計脈絡參考（凍結），`SETUP.md` 是部署的手動步驟。
>
> 上次更新：2026-05-26

---

## 1. Objective

### 1.1 是什麼
讓**競選團隊媒體組**透過網頁工具，對候選人歷年逐字稿做**主題式語意檢索**，找出所有提到該主題的歷史發言。

### 1.2 給誰用
媒體組成員（已被加入 Drive 資料夾分享名單的人）。

### 1.3 User story
> 媒體組成員打開網頁 → 用自己 Google 帳號登入 → 輸入「變電所」→ 看到候選人歷來所有提到該主題的發言，每筆含日期、分類、場合、Drive 連結、AI 摘要、高亮原文 → 一鍵複製單句或下載 CSV。
>
> **v1.0「精確搜尋」**：使用者輸入什麼字、就查什麼字（命中需字面出現）。  
> **v2.0「廣義搜尋」**（v1 上線後另開發）：使用者輸入後，工具自動以 Claude 發散相關詞再查（命中包含同義／關聯詞）。詳見 §13。

### 1.4 不是什麼
- 不是「貼一篇逐字稿做摘要」的工具（單篇摘要不在範圍）
- 不是內容管理工具（不上傳、不編輯、不刪除）
- 不是查詢歷史保存工具（逐字稿與查詢結果都不持久化、不快取；唯一持久化的是 localStorage 的「今日累計成本」這類本地小資料）

### 1.5 非功能性要求
- **裝置適配**：桌面與手機（≥ 375px 寬，iPhone SE 起跳）皆可完整使用
- **隱私揭露**：頁面需明示資料流向 — (1) 逐字稿送 Anthropic API、(2) Anthropic 預設不用於訓練、(3) Google 帳號僅用於 Drive 讀取
- **並發保護**：Worker 端走 Cloudflare 速率限制；前端等待回應時禁用搜尋按鈕避免連點

---

## 2. Tech Stack

| 層 | 技術 | 版本 | 備註 |
|---|---|---|---|
| 前端 | 單檔 HTML + 原生 JS + 原生 CSS | — | 無 build chain |
| 前端登入 | Google Identity Services (GIS) | latest CDN | scope `drive.readonly` |
| 前端 .docx 解析 | mammoth.js | 1.6.x（CDN） | 方案 A：前端解 |
| 後端 | Cloudflare Workers | — | JS、無 build |
| 後端部署工具 | wrangler | latest | 需 Node ≥ 18 |
| AI | Anthropic API | `claude-sonnet-4-6` | 部署前需 docs.claude.com 確認 ID 仍有效 |
| 儲存 | Google Drive | — | 透過使用者 OAuth token 直讀 |
| 前端託管 | GitHub Pages | — | 公開靜態 |

---

## 3. Commands

```bash
# 前端本機 dev
cd /Users/ailala/Documents/Claude/Projects/逐字稿檢索
python3 -m http.server 8000
# → http://localhost:8000

# Worker 本機 dev
cd worker/
npm install
wrangler dev
# → http://localhost:8787（或 wrangler 印的 port）

# Worker 部署
cd worker/
wrangler deploy

# Worker secret 設定
wrangler secret put ANTHROPIC_API_KEY

# 前端部署
git add index.html
git commit -m "..."
git push  # GitHub Pages 自動部署
```

本期不導入 lint / test framework（見 §6）。

---

## 4. Project Structure

```
逐字稿檢索/
├─ index.html              # 單檔前端（含 CSS + JS）
├─ SPEC.md                 # ← 本檔（單一真相來源）
├─ SETUP.md                # 帳號／金鑰／部署的手動步驟
├─ chat_to_code_HANDOFF.md # 設計脈絡（歷史檔，凍結）
└─ worker/
   ├─ worker.js            # Cloudflare Worker 主程式
   ├─ wrangler.toml        # 部署設定
   └─ package.json         # 相依清單（如有）
```

---

## 5. Code Style

- 前端 vanilla JS，無框架、無 bundler
- 縮排 2 空格；雙引號（`"`）為主
- 變數／函式 camelCase；常數 UPPER_SNAKE_CASE
- 註解寫**中文**（台灣用語），解釋 _why_ 不解釋 _what_
- 使用者面向所有文案（按鈕、錯誤、提示）一律繁體中文
- DOM 操作用原生 API，不引入 jQuery

**範例片段**：
```js
// v1.0 精確搜尋：粗篩直接用查詢字面比對
// 「不要漏」靠媒體組下精準關鍵字；精確判斷與摘要交給 Worker → Claude
function coarseFilter(text, query) {
  return text.includes(query);
}

// v2.0 廣義搜尋：粗篩前多一步 Claude 擴展（詳見 §13.2）
// async function expandQuery(query) {
//   const res = await fetch(WORKER_URL + "?mode=expand", { body: JSON.stringify({ query }) });
//   return (await res.json()).terms;   // → ["變電所", "台電", "電網", ...]
// }
```

---

## 6. Testing Strategy

**本期（MVP）不引入測試框架**。理由：單頁 + 薄 Worker，行為主要靠人工 smoke test 驗證，自動化測試 ROI 低。

**替代驗證機制**：每階段附 **Smoke Test 清單**（見 §11），實作完按表逐項驗。

**未來若導入**：
- 前端：Vitest（測純函式如 `coarseFilter` / `parseRocDate` / `highlight`）
- Worker：wrangler 內建 `unstable_dev` API
- 不做：UI E2E、覆蓋率指標

---

## 7. Boundaries

### 7.1 Always do
- 任何金鑰只進 Cloudflare secret，**永不**進 git / 前端 / 對話
- Drive scope 一律 `drive.readonly`
- 部署前在本機跑一次完整 happy path
- 所有使用者面向文案用繁體中文（台灣用語：軟體／資料 not 软件／数据）
- 民國年 → 西元年轉換要做（檔名 `1140520` = 西元 2025-05-20）
- Worker 上線時於 Cloudflare dashboard 設定 IP rate limit（建議 20 req/min/IP）
- 頁面需提供「隱私說明」入口（footer link 或 modal）
- CSS 採 responsive layout，斷點兼顧桌面與 ≥ 375px 寬手機

### 7.2 Ask first
（要動以下任何一項都需先跟使用者確認）
- 新增前端 lib 相依
- 變更 OAuth scope
- 變更 Worker 環境變數結構
- 改動 Drive folder ID 常數
- 引入 localStorage 以外的持久化機制
- 把硬寫死的 SYNONYMS 表搬到外部 config
- 切換 Claude model

### 7.3 Never do
- 把 ANTHROPIC_API_KEY 寫進前端或 commit
- 要求 Drive 寫入權限（`drive.file` / `drive` 等都不行）
- 新增檔案刪除／編輯／分享變更功能
- **跳過 Worker 端的 Drive 反查就直接呼叫 Claude**（會被當免費 proxy 燒額度）
- 沿用過期或猜測的 Claude model ID
- 建立後端資料庫或快取持久層
- 加入使用者白名單邏輯（權限完全委派 Drive，見 §8 Q9）

---

## 8. Decisions（Q1-Q10，已凍結）

| # | 議題 | 決策 |
|---|---|---|
| Q1 | 段落切分 | **雙換行為界**；單段超 1500 字以句號二切 |
| Q2 | excerpt 折疊 | 卡片預設折疊到 200 字；點「展開」看全文 |
| Q3 | OAuth token 過期 | 偵測 401 → 自動 silent re-auth；失敗才提示重登 |
| Q4 | 單次查詢上限 | 60 段／次；超過前端分批送 Worker，結果合併 |
| Q5 | 子資料夾 | **只掃頂層**，不遞迴 |
| Q6 | .txt 編碼 | 先試 UTF-8，亂碼 fallback Big5；都失敗 → 跳過該檔並提示 |
| Q7 | mimeType 白名單 | 只處理 `text/plain` + `application/vnd.google-apps.document` + `application/vnd.openxmlformats-officedocument.wordprocessingml.document`；其他全跳過（含影片、音檔、圖檔、PDF） |
| Q8 | Worker prompt | 中文台灣用語、JSON-only 輸出、寧漏勿濫（全文見 §9） |
| Q9 | Worker 擋人邏輯 | **Worker 拿使用者 token 反問 Drive**：能看到資料夾 → 通過；403/404 → 拒絕。**不維護獨立 ALLOWED_EMAILS** |
| Q10 | 錯誤 → UX | 11 類錯誤 matrix（見 §10） |
| Q11 | 版本策略 | **v1.0 精確搜尋先上線**（無擴展詞庫）；**v2.0 廣義搜尋另起開發**（Claude 自動擴展詞）；UI 加切換鈕「精確 / 廣義」共存。詳見 §13 |
| Q12 | 成本顯示 | 結果區顯示「本次查詢花費」+「今日累計花費」；只顯 USD；rates 寫死於前端常數（input $3 / 1M tokens、output $15 / 1M tokens） |

---

## 9. Worker Spec

### 9.1 Endpoint
- `POST /` （單一 endpoint）
- Body: `{ "transcripts": [{filename, date, occasion, category, text}, ...], "query": "..." }`
- Header: `Authorization: Bearer <google_oauth_access_token>`

### 9.2 處理流程
```
1. 驗證 Authorization header 有 token
2. 拿 token 呼叫 Drive API: GET /drive/v3/files/{FOLDER_ID}?fields=id
   - 對「受訪備份」「節目備份」任一資料夾能 GET 成功就通過
   - 兩個都 403/404 → 回 403 給前端
3. 組 prompt（見 §9.4）
4. 呼叫 Claude API
5. 解析 response.content[0].text
   - 去除可能的 ```json 圍欄
   - JSON.parse
   - 失敗 → 回 502 給前端
6. 回傳 JSON array 給前端
```

### 9.3 環境變數
- `ANTHROPIC_API_KEY`（secret）：Claude API key
- 硬寫死於程式：`DRIVE_FOLDER_IDS = ["1T797mt...", "1mB-xrRe..."]`、`MODEL = "claude-sonnet-4-6"`

### 9.4 Prompt（Q8 定案）
**System**
```
你是政治幕僚的研究助理，協助從候選人歷年的訪談、節目逐字稿中，檢索特定主題的歷史發言。

【任務】
我會給你：
1. 一個查詢主題（query）
2. 一組逐字稿候選段落（segments，已由前端做關鍵字粗篩，每段含 source_filename、date、occasion、category、text）

請判斷哪些段落「在語意上」真正與查詢主題相關（不只是字面湊巧出現關鍵字），並為相關段落生成一句中文摘要。

【判斷標準】
- 相關：段落主旨涉及該主題；或在該主題脈絡下提出觀點、數據、質詢、承諾
- 不相關：只是順帶提到關鍵字；或關鍵字出現在比喻、跳針口頭禪等無關語境
- 寧可漏（少報幾筆）勿濫（不要為了交差把可疑的也回）

【輸出】
只回一個 JSON array，無前言、無 markdown 圍欄、無說明文字。每個 element 結構：
{
  "source_filename": <原值原樣回傳>,
  "date": <原值原樣回傳>,
  "occasion": <原值原樣回傳>,
  "category": <原值原樣回傳>,
  "excerpt": <從原 text 中擷取最相關的連續片段，不改寫；若整段都相關回整段；最長 800 字>,
  "summary": <一句中文摘要，描述該段在主題上的立場/重點/動作；20-50 字>
}

若沒有任何段落相關，回 []
```

**User**
```
查詢主題：{query}

候選段落（JSON）：
{segments}
```

### 9.5 回傳 usage（給前端算成本）
Worker 從 Claude 回應中讀出 `usage.input_tokens` 與 `usage.output_tokens`，連同 results 一起回給前端：
```json
{
  "results": [...],
  "usage": {
    "input_tokens": 12345,
    "output_tokens": 678
  }
}
```
前端依寫死的 rates 計算 USD 成本顯示。**rates 變動時只改前端常數**（一處），不動 Worker。

### 9.6 v2.0 擴展端點（v2 才有）
v2 上線時，Worker 增加第二種模式：
- 端點：同 `POST /`，多帶參數 `?mode=expand`
- Body：`{ "query": "變電所" }`
- 行為：用簡短 prompt 請 Claude 回 5-10 個相關詞 JSON array
- 回傳：`{ "terms": [...], "usage": {...} }`
- v1 不需要實作此端點

### 9.7 並發與速率限制
- **IP rate limit**：於 Cloudflare dashboard 設定（不寫進程式碼，方便調整）；建議 20 req/min/IP；超過回 429
- **前端並發控制**：等待 Worker 回應期間禁用搜尋按鈕，避免使用者連點觸發重複呼叫
- **Worker 自身**：依賴 Cloudflare 自動 scaling 處理流量尖峰；本程式不另做佇列或 throttle
- **429 處理**：前端收到 429 → 顯示「請求太快，請稍等幾秒再試」+ 等 5 秒後重新啟用搜尋按鈕

---

## 10. Error → UX Matrix（Q10 定案）

| 錯誤類型 | 偵測方式 | 使用者看到 | 重試？ |
|---|---|---|---|
| 未登入 | 沒 token | 「請先登入 Google」+ 登入鈕高亮 | — |
| Token 過期 | Drive API 401 | 先 silent re-auth；失敗 → 「登入已過期，請重新登入」 | 自動 |
| Drive 權限不足（前端讀檔） | Drive API 403/404 | 「你的帳號可能未在此資料夾分享名單，請洽媒體組管理員」 | 否 |
| Worker 拒絕（反查 Drive 不通過） | Worker 回 403 | （同上一條） | 否 |
| Drive 暫時故障 | Drive API 5xx | 「Google Drive 暫時無回應，請稍後重試」+ 重試鈕 | 手動 |
| 粗篩無命中 | 前端結果為空 | 「沒有找到提到『{query}』的檔案。試試別的關鍵字」 | — |
| Worker 過載 / timeout | Worker 5xx 或 30s 無回應 | 「分析服務暫時無回應，請稍後重試」+ 重試鈕 | 手動 |
| Worker 速率限制 | Worker 回 429 | 「請求太快，請稍等幾秒再試」+ 搜尋鈕暫禁 5 秒 | 自動 5s 後啟用 |
| Claude 回傳格式錯誤 | JSON.parse 失敗（Worker 內） | 「分析結果解析失敗（暫時現象），請重試」；console 留詳情 | 手動 |
| Claude API 失敗 | Worker 內 catch | 「分析服務出錯（錯誤碼 {code}），請稍後重試」 | 手動 |
| 網路斷線 | fetch reject | 「無法連線到伺服器，請檢查網路」 | 手動 |
| 個別檔案解碼失敗 | UTF-8 + Big5 都失敗 | **不阻擋整體**；結果列上方提示「N 個檔案無法讀取」 | — |

---

## 11. Success Criteria（驗收條件）

實作完成的判定：以下全部通過 → 算 done。

### 11.1 功能驗收
- [ ] 媒體組成員用自己 Google 帳號登入後，能搜尋並看到結果卡片
- [ ] 卡片含：日期、分類 pill（節目／受訪）、場合、檔名、Drive 連結、AI 摘要、高亮原文（完全相符紅底、同義詞黃底）
- [ ] 卡片可一鍵複製「此句原文」
- [ ] 結果可下載為 .csv（含 7 欄）
- [ ] 民國年檔名 `1140520` 正確解析成 `2025-05-20`；解析失敗 fallback 顯示原檔名不 crash

### 11.2 安全驗收
- [ ] 媒體組以外的人即使知道網址，登入後也看不到任何逐字稿
- [ ] 攻擊者直接 `curl` Worker URL（任意 token 或無 token）收到 403
- [ ] GitHub repo 全文搜尋 `ANTHROPIC_API_KEY` 或 `sk-ant` 為零命中
- [ ] OAuth scope 只有 `drive.readonly`，無寫入權限
- [ ] 頁面含「隱私說明」入口，明示 3 點資料流向（送 Anthropic API、Anthropic 預設不訓練、Google 帳號僅 Drive 讀取）

### 11.3 體驗驗收
- [ ] 搜尋一個常見主題（如「變電所」），完整流程 ≤ 30 秒
- [ ] 12 類錯誤都有對應的中文 UX 訊息，無 console 錯誤外洩
- [ ] Token 過期時自動 re-auth，使用者不需手動登出再登入
- [ ] 手機（≥ 375px 寬，iPhone SE 起跳）可完成完整流程：登入、搜尋、看結果、複製、下載
- [ ] 5 人同時搜尋時無互踩；單人重複連點搜尋按鈕只觸發一次 Worker 呼叫
- [ ] Worker 速率超限時前端正確顯示「請稍等幾秒」並暫禁搜尋鈕
- [ ] 結果區顯示「本次查詢花費（USD）」與「今日累計花費（USD）」
- [ ] 搜尋框下提示文字明示「v1.0 精確搜尋」（媒體組知道要下精準關鍵字）

### 11.5 v2.0 驗收（v2 上線時補做）
- [ ] 搜尋框旁提供「精確 / 廣義」切換鈕，切換生效正確
- [ ] 廣義模式：呼叫 Claude 取得擴展詞後正確帶入粗篩
- [ ] 廣義模式單次成本顯示時，需包含擴展詞 call 的 token 成本（≈ +USD $0.005）
- [ ] 切換為廣義模式時，UI 明示「成本較高、覆蓋較廣」

### 11.4 Smoke Test 清單（部署後跑一輪）
1. 媒體組 A 帳號（在分享名單）→ 登入 → 搜「變電所」→ 應有結果
2. 路人甲帳號（不在分享名單）→ 登入 → 搜任何字 → 應顯示權限錯誤
3. 開 DevTools curl Worker URL → 應 403
4. 故意停網路再搜 → 應顯示「無法連線」
5. 上傳一份格式亂的檔名（如 `亂寫.txt`）到 Drive → 不應 crash，fallback 顯示原檔名
6. 試 Big5 編碼的 .txt → 應正常顯示中文

---

## 12. Open Questions（本期不解、未來再評估）

（v1.2 更新後本期已無 Open Questions——原唯一保留的「SYNONYMS 維護」議題改由 §13 版本路線圖解決：v1 走精確、v2 走 Claude 即時擴展，無需維護靜態詞庫。）

> 註：原 §12 共 7 條，經歷兩輪審查後處理結果：
> - 2026-05-26 v1.1：4 條拉進 MVP（IP rate limit / 行動裝置適配 / 大量並發 / 隱私聲明 UI）、2 條刪除（查詢歷史/收藏、多語系）
> - 2026-05-26 v1.2：剩餘「SYNONYMS 維護」轉為 §13 版本策略

---

## 13. Version Roadmap

### 13.1 v1.0「精確搜尋版」（先上線）

**檢索策略**：粗篩只用查詢字面（無擴展詞庫），精篩仍由 Claude 處理。

**使用者契約**：媒體組需自行下精準關鍵字。要找廣泛主題請多搜幾次（例：分別搜「變電所」「台電」「電網」，手動合併結果）。

**UI 提示**：
- 搜尋框下方明示「v1.0 精確搜尋・命中需查詢字面出現」
- 「沒命中」狀態提示「試試相近詞，或換用 v2 廣義模式（開發中）」

**Worker**：單一端點 `POST /`，行為見 §9.1-9.5、9.7。

**成本顯示**：本次 + 今日累計（USD），見 §11.3。

**完成條件**：§11.1-11.4 全部驗收通過、媒體組能在 1 天內上手。

### 13.2 v2.0「廣義搜尋版」（v1 上線後另起開發）

**檢索策略（加 1 步擴展）**：

```
使用者搜「變電所」
  ↓
【新增・Claude 擴展】Worker?mode=expand → Claude 回 ["變電所","電力","電網","台電",...]
  ↓
【粗篩・前端】用上述詞陣列掃所有檔案
  ↓
【精篩・Worker】同 v1
  ↓
顯示卡片
```

**Worker 變更**：新增 `?mode=expand` 端點，prompt 草稿：

> 「請給我『{query}』在台灣政治／政策語境下的相關詞與同義詞，包含正式名稱、口語、相關政策、相關機關。回 JSON array of strings，5-10 個，不要解釋。」

**UI 變更**：
- 搜尋框旁新增切換鈕「精確 / 廣義」（預設精確）
- 廣義模式選中時提示「成本較高、覆蓋較廣」
- 廣義模式單次成本約 v1 + USD $0.005（擴展 call）

**驗收**：見 §11.5。

### 13.3 為什麼這樣切

| 理由 | 說明 |
|---|---|
| **v1 程式單純、上線快** | 拿掉擴展邏輯後實作量降低 30%+；媒體組 1-2 週內可用 |
| **累積 v1 使用 data** | 上線後 1 個月可看出：常搜的主題、漏判模式、月度成本——這些是 v2 設計依據 |
| **v2 是擴充非重寫** | 兩者共用同一個 Worker 與精篩 prompt；v2 只多一個端點 + 一個 UI 按鈕 |
| **切換鈕讓使用者選** | 「有確定的詞」用精確、「不確定怎麼描述」用廣義；不強制 |
| **成本由使用者感知** | 顯示每次費用，媒體組自會選最划算的模式 |

### 13.4 v1.0 → v2.0 過渡注意

- v1 上線 30 天後評估是否啟動 v2 開發
- v2 開發期間 v1 持續運行不中斷
- v2 上線採 feature flag 漸進（例：先給 3 個 user 試 2 週，再全開）
- v2 上線後不撤 v1 — 兩個模式並存（切換鈕）

---

## 14. 變更紀錄

| 日期 | 變更 |
|---|---|
| 2026-05-26 | v1 初版（基於 HANDOFF.md + 10 條 Q&A 決策建立）|
| 2026-05-26 | v1.1 依 `spec-review.html` 互動審查回饋更新：(1) 新增 §1.5 非功能性要求；(2) §7 Always do 加 3 條（rate limit / 隱私入口 / responsive）；(3) 新增 §9.5 並發與速率限制；(4) §10 錯誤 matrix 加 429 一列；(5) §11 加 5 條新驗收（隱私說明、手機適配、並發、429 UX）；(6) §12 從 7 條砍剩 1 條 |
| 2026-05-26 | v1.2 改採 v1/v2 兩階段上線策略：(1) §1.3 User story 註明 v1 精確 / v2 廣義；(2) §1.4 補述 localStorage 用途；(3) §5 Code Style 移除 SYNONYMS 範例改成 v1 簡版；(4) §8 新增 Q11（版本策略）、Q12（成本顯示）；(5) §9 新增 9.5（usage 回傳）、9.6（v2 擴展端點）、9.5→9.7（並發限制重編號）；(6) §11 加 2 條 v1 成本驗收、新增 §11.5 v2 驗收；(7) §12 結案；(8) 新增 §13 版本路線圖 |
| 2026-05-26 | v1.2.1 修首次本機測試發現的兩個 bug：(1) **Drive Shared Drive 支援**：前端 `listFilesInFolder` / `readFileContent` 與 Worker `verifyDriveAccess` 全加 `supportsAllDrives=true`、列檔再加 `includeItemsFromAllDrives=true`——沒這兩個參數時 Shared Drive 內檔案會被靜默忽略（API 不報錯但回空陣列）；(2) **檔名解析增援西元年格式**：實際檔名是 `20260405【雅琴看世界】.txt` 而非預期 `1140520_記者會.txt`，parseFilename 改成同時支援西元年 8 位數（可選 `_` 或 `【】`）與民國年 7 位數兩種 |
| 2026-05-27 | v1.2.2 自動化 smoke test 抓到 bug：**廣義按鈕無回饋**。原本用 `<button disabled>` 抑制了 click event，使用者點下完全沒反應、看不到「v2 開發中」提示。改用 `aria-disabled="true"` + CSS attribute selector：視覺仍顯示為不可用，但 click handler 能正常觸發 toast |
