/**
 * scripts/smoke.js
 * 本地冒烟：零依赖、不联网，全部用桩 fetchImpl 代替上游。
 * 覆盖 initialize / tools.list / tools.call so_search / handleCredits 双 OK 与缺 Key skipped。
 * 任一步失败即非零退出；全部通过打印中文通过行。
 */

import { handleMcpRequest } from '../lib/mcp.js';
import { handleCredits } from '../lib/endpoints/credits.js';

/** 冒烟用的代理凭证（只活在本地进程）。 */
const PROXY_KEY = 'smoke-proxy-key';

/** 桩搜索结果：覆盖 name/url/content 与 title/link/snippet 两种上游字段形态。 */
const STUB_SEARCH_RESULTS = [
  { name: '冒烟标题一', url: 'https://smoke.local/a', content: '冒烟正文一' },
  { title: '冒烟标题二', link: 'https://smoke.local/b', snippet: '冒烟正文二' },
];

/**
 * 构造桩 Response（只实现调用方用到的 ok/status/json）。
 * @param {unknown} data 响应 JSON 负载
 * @param {number} [status] HTTP 状态码
 * @returns {{ok: boolean, status: number, json: () => Promise<unknown>}} 桩响应
 */
function stubResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

/**
 * 桩抓取实现：按地址路由到固定负载，未知地址直接抛错（暴露意外联网）。
 * @param {string} url 请求地址
 * @param {any} [init] 请求选项（含 body 供抓取路由用）
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<unknown>}>} 桩响应
 */
async function stubFetch(url, init = {}) {
  const text = String(url);
  if (text.includes('/v1/search')) {
    return stubResponse({ results: STUB_SEARCH_RESULTS });
  }
  if (text.includes('credits/balance')) {
    return stubResponse({ balance: 1234 });
  }
  if (text.includes('wallet')) {
    return stubResponse({ wallet: { credits: 5678 } });
  }
  if (text.includes('/v1/fetch')) {
    const body = JSON.parse(init.body || '{}');
    return stubResponse({ url: body.url, title: '冒烟抓取', markdown: '冒烟抓取正文' });
  }
  if (text.includes('tinyfish')) {
    return stubResponse({ results: [], errors: [] });
  }
  throw new Error('桩 fetch 收到未知地址：' + text);
}

/**
 * 断言 helper：失败即抛中文错误。
 * @param {unknown} condition 断言条件
 * @param {string} message 失败信息
 * @returns {void}
 */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** 依次执行冒烟步骤，失败抛错、成功打印中文通过行。 */
async function main() {
  // 1. initialize：服务名与协议版本。
  const initRes = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { fetchImpl: stubFetch },
  );
  check(initRes?.result?.serverInfo?.name === 'so-mcp', 'initialize 未返回 so-mcp 服务信息');
  console.log('通过：initialize 返回服务名 so-mcp');

  // 2. tools/list：四个工具齐全。
  const listRes = await handleMcpRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { fetchImpl: stubFetch },
  );
  const toolNames = (listRes?.result?.tools || []).map((/** @type {any} */ tool) => tool.name);
  for (const name of ['so_search', 'so_fetch', 'so_credits', 'so_verify']) {
    check(toolNames.includes(name), 'tools/list 缺少工具：' + name);
  }
  console.log('通过：tools/list 返回 so_search/so_fetch/so_credits/so_verify');

  // 3. tools/call so_search：桩结果正确映射 title/url/content。
  const callRes = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'so_search', arguments: { query: '冒烟关键词' } },
    },
    { searchProvider: 'linkup', linkupApiKey: 'smoke-linkup-key', fetchImpl: stubFetch },
  );
  const payload = JSON.parse(callRes?.result?.content?.[0]?.text || '{}');
  check(payload.provider === 'linkup', 'so_search 未返回 linkup 供应商标记');
  check(payload.results?.[0]?.title === '冒烟标题一', 'so_search 首条标题映射错误');
  check(payload.results?.[1]?.url === 'https://smoke.local/b', 'so_search 次条地址映射错误');
  check(payload.results?.[1]?.content === '冒烟正文二', 'so_search 次条正文映射错误');
  console.log('通过：tools/call so_search 映射 title/url/content 正确');

  // 4. handleCredits 双 OK：两家余额并行查到。
  const okRequest = new Request('https://smoke.local/credits', {
    headers: { 'x-api-key': PROXY_KEY },
  });
  const okResponse = await handleCredits(
    okRequest,
    {
      env: {
        PROXY_API_KEY: PROXY_KEY,
        LINKUP_API_KEY: 'smoke-linkup-key',
        TINYFISH_API_KEY: 'smoke-tinyfish-key',
      },
      fetchImpl: stubFetch,
    },
  );
  const okBody = await okResponse.json();
  check(okResponse.status === 200, 'handleCredits 双 OK 未回 200');
  check(
    okBody?.data?.linkup?.provider === 'linkup' &&
      typeof okBody.data.linkup.balance === 'number',
    'handleCredits linkup 余额缺失',
  );
  check(okBody?.data?.tinyfish?.provider === 'tinyfish', 'handleCredits tinyfish 钱包缺失');
  console.log('通过：handleCredits 双 Key 下两家余额均 OK');

  // 5. handleCredits 缺 Key：两家记 skipped 而不是报错。
  const skipRequest = new Request('https://smoke.local/credits', {
    headers: { 'x-api-key': PROXY_KEY },
  });
  const skipResponse = await handleCredits(
    skipRequest,
    { env: { PROXY_API_KEY: PROXY_KEY }, fetchImpl: stubFetch },
  );
  const skipBody = await skipResponse.json();
  check(
    skipBody?.data?.linkup?.skipped === true && skipBody?.data?.tinyfish?.skipped === true,
    'handleCredits 缺 Key 时未双双记 skipped',
  );
  console.log('通过：handleCredits 缺 Key 时双双记 skipped');

  console.log('冒烟全部通过');
}

main().catch((error) => {
  console.error('冒烟失败：' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
