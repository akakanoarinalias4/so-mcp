# so-mcp

Vercel 上的无状态 MCP 代理：统一搜索 / 抓取 / 验证，供应商可插拔。
搜索默认 Linkup，抓取主 Tinyfish、回退 Linkup。零运行时依赖，原生 ESM，Node 22.x。

本说明面向模型调用方：照标准工作流四步依次调三工具即可完成时效核验。
余额仅为人工查看用途，不参与工作流。

## 服务定位与鉴权

两个服务端点均需代理密钥鉴权，无密钥或错密钥一律 401：

- `POST /mcp`：Streamable HTTP，无状态，仅 POST 承载 JSON-RPC。
- `GET /credits`：独立余额快照，仅人工查额度，不参与工作流。

出示代理密钥三选一（优先级无关）：

1. `x-api-key: <PROXY_API_KEY>` 请求头；
2. `Authorization: Bearer <PROXY_API_KEY>` 请求头；
3. `?apiKey=<PROXY_API_KEY>` 查询参数（无法设置请求头的客户端兜底）。

缺出示回 `missing_api_key`，出示值与部署的 `PROXY_API_KEY` 不一致回 `invalid_api_key`。
上游密钥只读服务端环境变量，永不回传客户端、不打日志，客户端只持有 `PROXY_API_KEY`。

## 三工具详解

协议工具恰三项：`so_search`、`so_fetch`、`so_verify`。余额不再作为协议工具暴露。

- `so_search`：统一搜索。入参 `query`（必填）/`depth`（flash|fast|standard|deep）/
  `outputType`（searchResults|sourcedAnswer|structured）/`fromDate`/`toDate`（YYYY-MM-DD）/
  `maxResults`（1..50）/`includeDomains`/`excludeDomains`；
  出参 `{provider, results:[{title,url,content}], answer?}`。
- `so_fetch`：统一抓取。入参 `urls`（1..10 条）/`format`（markdown|html）/`ttl`/`perUrlTimeoutMs`；
  出参 `{results, errors, fallbackUsed, providers}`，失败条目带 `retryable` 标记。
- `so_verify`：时效多信源交叉验证。入参 `query`（必填）/`fromDate`/`toDate`/`maxResults`（默认 8）/
  `depth`（默认 standard）；先搜索取多源、按域名去重计数，再对 Top 地址抓取验时效，
  出参 `{query, window, sources, fetched, distinctDomains, consistent, notes}`。

## 标准工作流四步

目标：判断一个时效问题在多信源下是否一致。按序执行：

1. 搜取多源：调 `so_search`（`maxResults` 建议 8，`depth` 默认 standard，时效问题带 `fromDate`/`toDate`）。
2. 域名去重：对 `results[].url` 按域名去重计数，得 `distinctDomains`。
3. 抓验时效：对 Top 地址（最多 5 条）调 `so_fetch`，读 `results[].publishedDate`（如有）做时效备注。
4. 一致性判定：`sources>=2 且 distinctDomains>=2 且 fetched>=1` 即 `consistent: true`，
   否则为 false 并读 `notes` 看缺口（缺源 / 缺域名分散度 / 抓取失败）。

一键链路（推荐）：直接调 `so_verify`，一步走完四步：

```bash
curl -s 'https://<应用>.vercel.app/mcp' \
  -H 'content-type: application/json' -H "x-api-key: $PROXY_API_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"so_verify","arguments":{"query":"mcp search api","maxResults":8}}}'
```

手动分步链路（需自行取舍来源时用）：

```bash
# 第 1 步：搜索取多源
curl -s 'https://<应用>.vercel.app/mcp' \
  -H 'content-type: application/json' -H "x-api-key: $PROXY_API_KEY" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"so_search","arguments":{"query":"mcp search api","maxResults":8}}}'

# 第 3 步：对挑出的地址抓取验时效（域名去重与一致性判定在模型侧做）
curl -s 'https://<应用>.vercel.app/mcp' \
  -H 'content-type: application/json' -H "x-api-key: $PROXY_API_KEY" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"so_fetch","arguments":{"urls":["https://example.com/a"]}}}'
```

## 回退与重试语义

- 抓取：先调主供应商；`errors` 非空或整体抛错（且可重试）时，只把可重试地址交给回退供应商补抓，
  置 `fallbackUsed: true` 并在 `providers` 列出实际参与的两家；不可重试失败直接保留。
- 可重试语义：只有明确 `retryable: false`（如 401/402/404、余额不足）才跳过回退，其余默认可重试；
  包内错误枚举 `timeout` / `bot_blocked` / `target_unreachable` 恒可重试。
- 验证：抓取整体失败不阻断验证，仅记入 `notes`，`fetched` 为空则 `consistent` 为 false。

## 余额独立查看声明

余额不参与工作流，仅供人工查额度。协议工具列表无余额项，模型工作流四步中永不调用余额。
需人工确认剩余额度时，直接查独立端点：

```bash
curl -s 'https://<应用>.vercel.app/credits' -H "x-api-key: $PROXY_API_KEY"
# {"success":true,"data":{"linkup":{...},"tinyfish":{...}},"checkedAt":"..."}
```

两家并行查询，一家缺 Key 或失败都不阻塞另一家（缺 Key 记 `skipped`）。
该端点同样走统一准入鉴权：无代理密钥回 `missing_api_key`，错密钥回 `invalid_api_key`。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PROXY_API_KEY` | 是 | — | 客户端出示给本代理的凭证（唯一需要配给客户端的密钥）。 |
| `LINKUP_API_KEY` | 否 | — | Linkup 上游密钥（搜索 / 回退抓取 / 余额）。缺则相关调用记 `skipped` 或报错，不阻断另一家。 |
| `TINYFISH_API_KEY` | 否 | — | Tinyfish 上游密钥（主抓取 / 钱包）。缺则主抓取走回退、钱包记 `skipped`。 |
| `SEARCH_PROVIDER` | 否 | `linkup` | 搜索供应商名。 |
| `FETCH_PRIMARY` | 否 | `tinyfish` | 抓取主供应商名。 |
| `FETCH_FALLBACK` | 否 | `linkup` | 抓取回退供应商名（与主同名时不回退）。 |
| `CREDITS_TIMEOUT_MS` | 否 | `15000` | 余额查询独立超时（毫秒），远小于函数执行上限。 |

## 部署与本地验证

1. 把本仓库导入 Vercel（Import Git，框架选 Other）。
2. 在项目 Settings → Environment Variables 设置上表变量（至少 `PROXY_API_KEY`）。
3. 点 Deploy，得到 `https://<应用>.vercel.app`。
4. 验证 MCP 握手：
   ```bash
   curl -s 'https://<应用>.vercel.app/mcp' \
     -H 'content-type: application/json' \
     -H "x-api-key: $PROXY_API_KEY" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
   ```
5. 验证工具列表（应恰为搜、抓、验证三项）：
   ```bash
   curl -s 'https://<应用>.vercel.app/mcp' \
     -H 'content-type: application/json' -H "x-api-key: $PROXY_API_KEY" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
   ```
6. 本地冒烟（不联网，桩代替上游）：`node scripts/smoke.js`；跑单测：`npm test`。

MCP 客户端 JSON 配置示例（按客户端文档把域名与密钥填入）：

```json
{
  "mcpServers": {
    "so-mcp": {
      "url": "https://<应用>.vercel.app/mcp",
      "headers": { "x-api-key": "<PROXY_API_KEY>" }
    }
  }
}
```

## 避坑

1. 无状态：服务端不存会话。`GET /mcp` 固定 405、`DELETE` 固定 400（没有可终止的会话），
   无 `id` 的通知按 JSON-RPC 约定只回 202 空确认；每次请求都要带凭证。
2. 超时拆分：余额查询有独立超时（`CREDITS_TIMEOUT_MS`，默认 15 秒）并与函数整体超时竞速；
   抓取的 `ttl` / `perUrlTimeoutMs` 会透传上游；Vercel Hobby 函数有执行时长上限，
   大批量抓取请拆成多次 `so_fetch` 调用（每次 ≤10 条）。
3. 密钥不进前端：`LINKUP_API_KEY` / `TINYFISH_API_KEY` 只放 Vercel 服务端环境变量，
   永远不要写进前端代码、客户端配置或仓库；客户端只持有 `PROXY_API_KEY`，
   上游密钥永不回传、不打日志。
4. 余额别进工作流：模型做时效核验只走搜、抓、验证三工具；余额端点只给人看额度，
   不要在搜 / 抓 / 验之间插余额调用。
