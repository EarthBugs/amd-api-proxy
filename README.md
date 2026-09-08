# amd-api-proxy

一个部署在 Cloudflare Workers 上的轻量适配代理：让 ZCode（或任何会发送顶层 `thinking` 参数的 OpenAI 兼容客户端）能够正常调用 AMD 开发者端点上的 DeepSeek 系列模型。AMD 端点上的 Qwen 等其他模型不受影响，请求原样透传。

## 解决什么问题

AMD 开发者端点（`https://developer.amd.com.cn/radeon/api/v1`，sglang-router 网关）上，只有 DeepSeek 系模型存在 thinking 兼容问题：ZCode 内核对模型 ID 匹配 `deepseek-v4` 的请求会自动注入顶层 `thinking` 参数（思考档 high/max 注入 `thinking:{type:"enabled"}`，关闭档注入 `thinking:{type:"disabled"}`），而网关的 `supported_parameters` 白名单不含 `thinking`，收到即返回：

```
"thinking" is not supported on /v1/chat/completions and was not applied.
Use "reasoning_effort" (or "reasoning.effort") to control thinking.
```

`reasoning_effort` 是网关唯一例外放行的推理控制参数。本 Worker 位于客户端与 AMD 之间做适配。

## 转换规则

- **按模型分流**：仅当请求体 `model` 字段包含 `deepseek`（大小写不敏感，关键字匹配，覆盖 flash / pro / flash-exp 及后续新模型）时应用下方转换；其余模型请求体原样 bypass。
- **白名单透传**（仅 DeepSeek 系）：仅保留 AMD 支持的参数 —— `model`、`messages`、`temperature`、`max_tokens`、`top_p`、`stream`、`response_format`、`tools`、`tool_choice`、`reasoning_effort`；其余参数（`thinking`、`reasoning` 等）一律剥离。
- **思考档位归一**（仅 DeepSeek 系）：`reasoning_effort` / `reasoning.effort` / `thinking.effort` 三种写法统一成顶层 `reasoning_effort`；`max → high`、`minimal → low`、`none/off/disabled → 剥离`（网关仅认 low/medium/high）。
- **鉴权透传**：`Authorization` 头原样转发，AMD API key 仍保存在客户端，Worker 不存储任何密钥。
- **流式透传**：SSE 响应原样透传（含 `content-encoding/content-length` 头修正）。
- **路径兼容**：`/v1/...` 前缀可选（网关 base 已含 `/api/v1`）；GET 请求（如 `/models`）不改体直接转发。

## 部署

```bash
cp wrangler.toml.example wrangler.toml   # 填入你自己的 worker 名与自定义域
npx wrangler deploy
```

需要环境变量 `CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit 权限）与 `CLOUDFLARE_ACCOUNT_ID`。真实 `wrangler.toml` 含你的自定义域等私有信息，已列入 `.gitignore` 不入库；配置自定义域后 wrangler 默认停用 `workers.dev` 路由，仅保留自定义域。

## ZCode 侧接入

将 AMD provider 的 `baseURL` 从 `https://developer.amd.com.cn/radeon/api/v1` 改为你的 Worker 地址（部署输出中的 custom domain）加 `/v1` 后缀，API key 不变。

## 已知限制

- AMD 端点非流式响应不回传 `reasoning_content`（`reasoning_tokens` 有值但思考正文为 null）；流式响应则会通过 `delta.reasoning` 字段回传思考文本（非 OpenAI 标准字段，客户端是否展示取决于其 SDK 支持）。
- AMD 的 DeepSeek-V4-Flash 并发上限 80，高峰期可能返回 `model_concurrency_rate_limit_exceeded`，重试即可。
