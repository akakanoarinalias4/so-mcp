/**
 * Linkup 搜索供应商（统一搜形状适配层）。
 *
 * 上游：POST https://api.linkup.so/v1/search，Bearer 鉴权。
 * 职责：把 UnifiedSearch 输入映射为 Linkup 参数，把 Linkup 输出归一为 UnifiedSearch 输出。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlLinkup 优先）。
const DEFAULT_SEARCH_URL = 'https://api.linkup.so/v1/search';

/** 允许的检索深度枚举。 */
const ALLOWED_DEPTHS = new Set(['flash', 'fast', 'standard', 'deep']);

/** 允许的输出形态枚举。 */
const ALLOWED_OUTPUT_TYPES = new Set(['searchResults', 'sourcedAnswer', 'structured']);

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {'flash'|'fast'|'standard'|'deep'} [depth] 检索深度
 * @property {'searchResults'|'sourcedAnswer'|'structured'} [outputType] 输出形态
 * @property {string} [fromDate] 起始日期（ISO，如 2024-01-01）
 * @property {string} [toDate] 结束日期（ISO）
 * @property {number} [maxResults] 来源数量上限
 * @property {string[]} [includeDomains] 域名白名单
 * @property {string[]} [excludeDomains] 域名黑名单
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'linkup'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string}>} results 结果列表
 * @property {string} [answer] 答案（sourcedAnswer 时）
 * @property {unknown} [raw] 上游原始响应
 */

/**
 * 构造携带结构化字段的错误。
 * @param {string} code 错误码
 * @param {string} message 错误信息
 * @param {{status?: number, retryable?: boolean}} [extra] 附加字段
 * @returns {Error & {code: string, status?: number, retryable?: boolean}} 结构化错误
 */
function fail(code, message, extra) {
  const err = /** @type {Error & {code: string, status?: number, retryable?: boolean}} */ (
    new Error(message)
  );
  err.code = code;
  if (extra && extra.status !== undefined) err.status = extra.status;
  if (extra && extra.retryable !== undefined) err.retryable = extra.retryable;
  return err;
}

/**
 * 从 deps 解析 Linkup 密钥与搜索地址。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveLinkup(deps) {
  const apiKey =
    (deps && (deps.linkupApiKey || deps.linkupKey || deps.LINKUP_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 LINKUP_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.searchUrlLinkup || deps.linkupSearchUrl)) || DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * Linkup 搜索。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 linkupApiKey、searchUrlLinkup）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function linkupSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = (params && params.query) || '';
  if (!query || typeof query !== 'string') {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const depth =
    params.depth && ALLOWED_DEPTHS.has(params.depth) ? params.depth : 'standard';
  const outputType =
    params.outputType && ALLOWED_OUTPUT_TYPES.has(params.outputType)
      ? params.outputType
      : 'searchResults';

  const { apiKey, url } = resolveLinkup(deps);

  // 组装上游请求体，仅透传非空可选字段。
  // 上游请求体字段动态（可选字段按需透传），整体压为 any，避免隐式 any 报错。
  const body = /** @type {any} */ ({ q: query, depth, outputType });
  if (params.fromDate) body.fromDate = params.fromDate;
  if (params.toDate) body.toDate = params.toDate;
  if (params.maxResults !== undefined) body.maxResults = params.maxResults;
  if (params.includeDomains) body.includeDomains = params.includeDomains;
  if (params.excludeDomains) body.excludeDomains = params.excludeDomains;

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    // 网络层异常视为可重试的上游不可用。
    throw fail('UPSTREAM_UNAVAILABLE', 'Linkup 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Linkup 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Linkup 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 余额耗尽或并发超限：透传且标记不可重试（调用方决定是否换源）。
    throw fail('UPSTREAM_RATE_LIMITED', 'Linkup 配额耗尽或限流（429）', {
      status: 429,
      retryable: false,
    });
  }
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 408;
    throw fail('UPSTREAM_ERROR', 'Linkup 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();
  const items = Array.isArray(data && data.results)
    ? data.results
    : Array.isArray(data && data.sources)
      ? data.sources
      : [];

  const results = items
    .filter((/** @type {any} */ item) => item && (item.url || item.link))
    .map((/** @type {any} */ item) => ({
      title: String(item.name || item.title || item.url || item.link || ''),
      url: String(item.url || item.link || ''),
      content: String(item.content || item.snippet || item.text || ''),
    }));

  /** @type {UnifiedSearchResult} */
  const out = { provider: 'linkup', results, raw: data };
  const answer =
    (data && (data.answer || data.sourcedAnswer)) || undefined;
  if (typeof answer === 'string' && answer) out.answer = answer;
  return out;
}
