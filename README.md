# so-mcp

Vercel 上的无状态 MCP 代理：统一搜索 / 抓取 / 余额 / 验证，供应商可插拔。
搜索默认 Linkup，抓取主 Tinyfish、回退 Linkup。零运行时依赖，原生 ESM，Node 22.x。

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

密钥只读服务端环境变量：上游密钥永不回传客户端、不打日志。客户端只持有 `PROXY_API_KEY`。

## 一键部署（Vercel）

1. 把本仓库导入 Vercel（Import Git，框架选 Other）。
2. 在项目 Settings → Environment Variables 设置上表变量（至少 `PROXY_API_KEY`）。
3. 点 Deploy，得到 `https://<应用>.vercel.app`。
4. 验证余额接口（把 `<应用>` 换成实际域名）：
   ```bash
   curl -s 'https://<应用>.vercel.app/credits' -H "x-api-key: $PROXY_API_KEY"
   ```
5. 验证 MCP 握手：
   ```bash
   curl -s 'https://<应用>.vercel.app/mcp' \
     -H 'content-type: application/json' \
     -H "x-api-key: $PROXY_API_KEY" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
   ```
6. 本地冒烟（不联网，桩代替上游）：`node scripts/smoke.js`；跑单测：`npm test`。

## 客户端配置

出示凭证三选一（优先级无关）：`x-api-key` 请求头、`Authorization: Bearer <PROXY_API_KEY>`、
`?apiKey=<PROXY_API_KEY>`（无法设置请求头的客户端兜底）。

`/mcp`（Streamable HTTP，无状态，仅 POST 承载 JSON-RPC）：

```bash
# 工具列表
curl -s 'https://<应用>.vercel.app/mcp' \
  -H 'content-type: application/json' -H "x-api-key: $PROXY_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 调搜索工具
curl -s 'https://<应用>.vercel.app/mcp' \
  -H 'content-type: application/json' -H "x-api-key: $PROXY_API_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"so_search","arguments":{"query":"mcp search api"}}}'
```

`/credits`（余额快照，双路并行、互不阻塞）：

```bash
curl -s 'https://<应用>.vercel.app/credits?apiKey=$PROXY_API_KEY'
# {"success":true,"data":{"linkup":{...},"tinyfish":{...}},"checkedAt":"..."}
```

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

## 四工具说明

- `so_search`：统一搜索。入参 `query`（必填）/`depth`/`outputType`/`fromDate`/`toDate`/
  `maxResults`/`includeDomains`/`excludeDomains`；出参 `{provider, results:[{title,url,content}], answer?}`。
- `so_fetch`：统一抓取。入参 `urls`（1..10 条）/`format`/`ttl`/`perUrlTimeoutMs`；
  出参 `{results, errors, fallbackUsed, providers}`，失败条目带 `retryable` 标记。
- `so_credits`：余额查询。无入参；并行查两家，出参 `{linkup, tinyfish, checkedAt}`，
  缺 Key 的一方记 `skipped` 而不是报错。
- `so_verify`：时效多信源交叉验证。入参 `query`/`fromDate`/`toDate`/`maxResults`/`depth`；
  先搜索取多源、按域名去重计数，再对 Top 地址抓取验时效，
  出参 `{query, window, sources, fetched, distinctDomains, consistent, notes}`。

## 回退策略

- 抓取：先调主供应商；`errors` 非空或整体抛错（且可重试）时，只把可重试地址交给回退供应商补抓，
  置 `fallbackUsed: true` 并在 `providers` 列出实际参与的两家；不可重试失败直接保留。
- 余额：两家并行查询，一家缺 Key 或失败都不阻塞另一家。
- 可重试语义：只有明确 `retryable: false`（如 401/402/404、余额不足）才跳过回退，其余默认可重试；
  包内错误枚举 `timeout` / `bot_blocked` / `target_unreachable` 恒可重试。

## 三坑

1. 无状态：服务端不存会话。`GET /mcp` 固定 405、`DELETE` 固定 400（没有可终止的会话），
   无 `id` 的通知按 JSON-RPC 约定只回 202 空确认；每次请求都要带凭证。
2. 超时拆分：余额查询有独立超时（`CREDITS_TIMEOUT_MS`，默认 15 秒）并与函数整体超时竞速；
   抓取的 `ttl` / `perUrlTimeoutMs` 会透传上游；Vercel Hobby 函数有执行时长上限，
   大批量抓取请拆成多次 `so_fetch` 调用（每次 ≤10 条）。
3. 密钥不进前端：`LINKUP_API_KEY` / `TINYFISH_API_KEY` 只放 Vercel 服务端环境变量，
   永远不要写进前端代码、客户端配置或仓库；客户端只持有 `PROXY_API_KEY`，
   上游密钥永不回传、不打日志。
