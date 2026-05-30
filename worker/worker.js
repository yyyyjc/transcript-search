// Cloudflare Worker — 逐字稿語料庫語意檢索後端
//
// 真相來源：../SPEC.md
// 部署：見 ../SETUP.md Phase 3
//
// ⚠️ 部署前必須驗證 MODEL 常數仍是當前可用 Claude model ID
//    參考 https://docs.claude.com/en/docs/about-claude/models

// === 設定 ===

const DRIVE_FOLDER_IDS = [
  "1T797mtvd52IYEad1up2MjJV-5w3GLoaC", // 受訪備份
  "1mB-xrRe9jb4AiAg22XABmg9rzP1JYIxq", // 節目備份
];

const MODEL = "claude-sonnet-4-6"; // ⚠️ 部署前驗證
const MAX_TOKENS = 4096;
const MAX_SEGMENTS_PER_REQUEST = 100; // 防爆保險（SPEC §8 Q4 已規範前端 60 段；此處留 buffer）

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3/files";

// CORS：MVP 階段 allow any origin（實際安全靠 Drive token 反查擋人）
// 未來若要鎖死，改成具體 GitHub Pages URL
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

// === Prompt（SPEC §9.4 全文）===

const SYSTEM_PROMPT = `你是政治幕僚的研究助理，協助從候選人歷年的訪談、節目逐字稿中，檢索特定主題的歷史發言。

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

若沒有任何段落相關，回 []`;

// === 主要入口 ===

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    try {
      // 1. 取 OAuth token
      const token = extractToken(request);
      if (!token) {
        return jsonResponse({ error: "missing_token", message: "缺少 Authorization header" }, 401);
      }

      // 2. 反查 Drive，驗證使用者有權限
      const driveCheck = await verifyDriveAccess(token);
      if (!driveCheck.ok) {
        return jsonResponse(
          { error: driveCheck.reason, message: driveCheck.message },
          driveCheck.status
        );
      }

      // 3. 解析 body
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ error: "invalid_json", message: "Request body 不是合法 JSON" }, 400);
      }

      const url = new URL(request.url);
      const mode = url.searchParams.get("mode") || "search";

      // v2 才有 expand 模式；v1 拒絕
      if (mode === "expand") {
        return jsonResponse(
          { error: "expand_not_implemented", message: "?mode=expand 在 v2 才會實作" },
          501
        );
      }

      // 4. 驗證 body
      const { transcripts, query } = body;
      if (!Array.isArray(transcripts) || typeof query !== "string" || !query.trim()) {
        return jsonResponse({ error: "invalid_body", message: "需要 { transcripts: [...], query: '...' }" }, 400);
      }
      if (transcripts.length === 0) {
        return jsonResponse({ results: [], usage: { input_tokens: 0, output_tokens: 0 } });
      }
      if (transcripts.length > MAX_SEGMENTS_PER_REQUEST) {
        return jsonResponse(
          { error: "too_many_segments", message: `單次最多 ${MAX_SEGMENTS_PER_REQUEST} 段，請分批送` },
          413
        );
      }

      // 5. 呼叫 Claude
      const claudeRes = await callClaude(query, transcripts, env.ANTHROPIC_API_KEY);
      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        console.error(`Claude API ${claudeRes.status}:`, errText.slice(0, 500));
        return jsonResponse(
          { error: "claude_api_error", status: claudeRes.status, message: "Claude API 呼叫失敗" },
          502
        );
      }

      const claudeData = await claudeRes.json();

      // 6. 解析 Claude 回應
      const textBlock = claudeData.content?.find((b) => b.type === "text");
      if (!textBlock) {
        console.error("Claude response has no text block:", JSON.stringify(claudeData).slice(0, 500));
        return jsonResponse({ error: "no_text_in_response", message: "Claude 回應無 text 內容" }, 502);
      }

      let parsed;
      try {
        parsed = parseJsonFromClaude(textBlock.text);
      } catch (e) {
        console.error("JSON parse failed:", e.message, "Raw:", textBlock.text.slice(0, 500));
        return jsonResponse(
          { error: "json_parse_failed", message: "Claude 回的內容不是合法 JSON" },
          502
        );
      }

      if (!Array.isArray(parsed)) {
        return jsonResponse(
          { error: "result_not_array", message: "Claude 回的不是 JSON array" },
          502
        );
      }

      // 7. 回傳 results + usage
      return jsonResponse({
        results: parsed,
        usage: {
          input_tokens: claudeData.usage?.input_tokens || 0,
          output_tokens: claudeData.usage?.output_tokens || 0,
        },
        model: claudeData.model || MODEL,
      });
    } catch (err) {
      console.error("Worker uncaught error:", err.stack || err.message);
      return jsonResponse({ error: "internal_error", message: err.message }, 500);
    }
  },
};

// === Helpers ===

function extractToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * SPEC §9.2 步驟 2：拿使用者 token 反問 Drive
 * 對兩個資料夾任一能 GET 成功 → 通過
 * 兩個都 403/404 → 拒絕
 * Token 無效（401）→ 直接回 401 讓前端 re-auth
 */
async function verifyDriveAccess(token) {
  for (const folderId of DRIVE_FOLDER_IDS) {
    // supportsAllDrives 對 Shared Drive 必需；對 My Drive 也無害
    const res = await fetch(`${DRIVE_API_URL}/${folderId}?fields=id&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      return { ok: true };
    }
    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        reason: "token_invalid",
        message: "Google token 無效或已過期，請重新登入",
      };
    }
    // 403 / 404 → 繼續試下一個資料夾
  }
  return {
    ok: false,
    status: 403,
    reason: "drive_access_denied",
    message: "你的帳號可能未在資料夾分享名單，請洽媒體組管理員",
  };
}

async function callClaude(query, transcripts, apiKey) {
  const userMessage = `查詢主題：${query}\n\n候選段落（JSON）：\n${JSON.stringify(transcripts)}`;
  return fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
}

/**
 * 處理 Claude 偶爾回傳帶 markdown 圍欄或前後說明文字的情況
 * 找出第一個 [ 到最後一個 ] 之間的內容做 JSON.parse
 */
function parseJsonFromClaude(text) {
  let cleaned = text.trim();
  // 去掉 markdown 圍欄
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("找不到 JSON array 邊界");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}
