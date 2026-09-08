// AMD 开发者端点适配代理：ZCode → Cloudflare Worker → AMD developer endpoint
//
// 背景：AMD 端点上只有 DeepSeek 系模型存在 thinking 兼容问题——ZCode 内核对
// 模型 ID 匹配 deepseek-v4 的请求会注入顶层 thinking 参数（variant high/max
// 注入 thinking:{type:"enabled"}，关闭思考档注入 thinking:{type:"disabled"}），
// AMD 网关（sglang-router）的 supported_parameters 白名单不含 thinking，
// 收到即 400 unsupported_parameter，仅 reasoning_effort 被例外放行。
// Qwen 等其他模型无此问题。因此本 Worker 仅对模型名含 deepseek 的请求
// 做白名单过滤 + 档位归一，其余模型请求体原样透传（bypass）。

const AMD_BASE = "https://developer.amd.com.cn/radeon/api/v1";

// AMD 白名单（temperature/max_tokens/top_p/stream/response_format/tools/tool_choice）
// + reasoning_effort。其余参数（thinking、reasoning、stream_options 等）一律剥离，
// 避免网关对首个不认识的参数直接 400。
const ALLOWED = [
  "model",
  "messages",
  "temperature",
  "max_tokens",
  "top_p",
  "stream",
  "response_format",
  "tools",
  "tool_choice",
  "reasoning_effort",
];

// 网关仅认 low/medium/high，越界档位就近收敛；关闭类档位直接剥掉
const EFFORT_MAP = { minimal: "low", max: "high" };
const EFFORT_OFF = new Set(["none", "off", "disabled"]);
const EFFORT_VALID = new Set(["low", "medium", "high"]);

// 仅 DeepSeek 系模型需要适配；用关键字匹配而非枚举型号，覆盖 flash/pro/exp 及后续新模型
function needsDeepseekFix(model) {
  return typeof model === "string" && model.toLowerCase().includes("deepseek");
}

function sanitize(body) {
  const out = {};
  for (const key of ALLOWED) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  // 各客户端对思考档位的写法不一：reasoning_effort / reasoning.effort / thinking.effort
  let effort =
    body.reasoning_effort ?? body.reasoning?.effort ?? body.thinking?.effort;
  if (typeof effort === "string" && !EFFORT_OFF.has(effort)) {
    effort = EFFORT_MAP[effort] ?? effort;
    if (EFFORT_VALID.has(effort)) out.reasoning_effort = effort;
  }
  return out;
}

async function proxy(srcReq, target, jsonBody) {
  const headers = new Headers(srcReq.headers);
  headers.delete("host");
  headers.delete("content-length");
  const init = { method: srcReq.method, headers };
  if (jsonBody !== null) {
    headers.set("content-type", "application/json");
    init.body = jsonBody;
  }
  let resp;
  try {
    resp = await fetch(target, init);
  } catch (err) {
    return json({ error: { message: `upstream fetch failed: ${err.message}` } }, 502);
  }
  const out = new Headers(resp.headers);
  // fetch 已透明解压，透传时去掉长度/编码头，避免客户端按 gzip 解析
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: out,
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, upstream: AMD_BASE });
    }

    // 兼容两种 baseUrl 配法：带 /v1 前缀的剥掉（AMD_BASE 已含 /api/v1）
    let path = url.pathname;
    if (path === "/v1") path = "";
    else if (path.startsWith("/v1/")) path = path.slice(3);
    const target = AMD_BASE + path + url.search;

    if (request.method !== "POST") {
      return proxy(request, target, null);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: "request body is not valid JSON" } }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: { message: "request body must be a JSON object" } }, 400);
    }

    const cleaned = needsDeepseekFix(body.model) ? sanitize(body) : body;
    return proxy(request, target, JSON.stringify(cleaned));
  },
};
