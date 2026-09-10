# amd-api-proxy

一个部署在 Cloudflare Workers 上的轻量适配代理：让 ZCode（或任何会发送顶层 `thinking` 参数的 OpenAI 兼容客户端）能够正常调用 AMD 开发者端点上的 DeepSeek / Qwen 系列模型。其余模型请求原样透传。

## 解决什么问题

AMD 开发者端点（`https://developer.amd.com.cn/radeon/api/v1`，sglang-router 网关）上，只有 DeepSeek 系模型存在 thinking 兼容问题：ZCode 内核对模型 ID 匹配 `deepseek-v4` 的请求会自动注入顶层 `thinking` 参数（思考档 high/max 注入 `thinking:{type:"enabled"}`，关闭档注入 `thinking:{type:"disabled"}`），而网关的 `supported_parameters` 白名单不含 `thinking`，收到即返回：

```
"thinking" is not supported on /v1/chat/completions and was not applied.
Use "reasoning_effort" (or "reasoning.effort") to control thinking.
```

`reasoning_effort` 是网关唯一例外放行的推理控制参数。Qwen 系模型虽然不报这个错，但后端只接受 `none / low / medium / xhigh` 四个思考档位（`minimal / high / max` 返回 400），档位参数同样只有 `reasoning_effort` 一条路。本 Worker 位于客户端与 AMD 之间做适配。

## 转换规则

- **按模型分流**：按请求体 `model` 字段的关键字（大小写不敏感）分流：包含 `deepseek` 走 DeepSeek 规则，包含 `qwen` 走 Qwen 规则；其余模型请求体原样 bypass。
- **白名单透传**（仅 DeepSeek 系）：仅保留 AMD 支持的参数 —— `model`、`messages`、`temperature`、`max_tokens`、`top_p`、`stream`、`response_format`、`tools`、`tool_choice`、`reasoning_effort`；其余一律剥离。
- **思考档位归一**（仅 DeepSeek 系）：`reasoning_effort` / `reasoning.effort` / `thinking.effort` 三种写法统一成顶层 `reasoning_effort`；`max → high`、`minimal → low`、`none/off/disabled → 剥离`（网关仅认 low/medium/high）。
- **Qwen 档位归一**（仅 Qwen 系）：后端实测仅接受 `reasoning_effort ∈ none/low/medium/xhigh`（`minimal/high/max` 返回 400）。归一表：`off/nothink/disabled → none`、`minimal → low`、`high/max → xhigh`；未知值删除参数；同时剥离 `thinking` / `reasoning`（裸 `thinking` 参数会被网关 400 拒绝）。
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

### Qwen3.8-Flash-Next 思考档位（四档）

AMD 端点上 Qwen3.8-Flash-Next 默认只有开/关两档思考；在 ZCode 的 provider 配置文件（`config.json` 中该模型的 `reasoning` 字段）显式声明四档，即可把思考选择器扩展为 关 / low / medium / xhigh：

```json
"reasoning": {
  "enabled": true,
  "variants": ["off", "low", "medium", "xhigh"],
  "defaultVariant": "xhigh",
  "providerOptionsByLevel": {
    "off":    { "openaiCompatible": { "reasoningEffort": "none" } },
    "low":    { "openaiCompatible": { "reasoningEffort": "low" } },
    "medium": { "openaiCompatible": { "reasoningEffort": "medium" } },
    "xhigh":  { "openaiCompatible": { "reasoningEffort": "xhigh" } }
  }
}
```

四档均经 Worker 实测生效：关档 `reasoning_tokens = 0`（思考确实关闭），其余三档正常产出思考 token。改完需重启 ZCode 生效。若 UI 后续重写该字段丢失档位声明，重新粘回本段即可。

## 已知限制

- AMD 端点非流式响应不回传 `reasoning_content`（`reasoning_tokens` 有值但思考正文为 null）；流式响应则会通过 `delta.reasoning` 字段回传思考文本（非 OpenAI 标准字段，客户端是否展示取决于其 SDK 支持）。
- AMD 的 DeepSeek-V4-Flash 并发上限 80，高峰期可能返回 `model_concurrency_rate_limit_exceeded`，重试即可。
- AMD Qwen3.8-Flash-Next 的 `reasoning_effort` 仅接受 `none/low/medium/xhigh`（`minimal/high/max` 返回 400，`high` 也不行）；顶层 `thinking` 参数同样被 400 拒绝。低档位下思考 token 数并不严格单调（模型自主控制深度），档位差异在复杂任务上才明显。
- Worker 的 Cloudflare 自定义域会拦截无浏览器 UA 的请求（error 1010），命令行 curl/脚本测试需带正常 `User-Agent` 头；真实客户端不受影响。
