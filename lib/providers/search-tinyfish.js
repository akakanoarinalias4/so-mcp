/**
 * Tinyfish 搜索供应商（统一搜索形状适配层）。
 *
 * 上游：GET https://api.search.tinyfish.ai，请求头 X-API-Key。
 * 计费：搜索免费，任意钱包余额（含 0）均可调用，零计费。
 * 限速：默认每分钟 30 次、每小时 500 次，超限回 429（可重试）。
 * 职责：把 UnifiedSearch 输入映射为 Tinyfish 查询参数，把结果归一为 UnifiedSearch 输出。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlTinyfish 优先）。
const DEFAULT_SEARCH_URL = 'https://api.search.tinyfish.ai';

/** 允许的域名类型枚举。 */
const ALLOWED_DOMAIN_TYPES = new Set(['web', 'news', 'research_paper']);

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {'flash'|'fast'|'standard'|'deep'} [depth] 检索深度（本适配忽略，仅兼容网关透传）
 * @property {'searchResults'|'sourcedAnswer'|'structured'} [outputType] 输出形态（本适配无答案字段）
 * @property {string} [fromDate] 起始日期（YYYY-MM-DD，映射 after_date）
 * @property {string} [toDate] 结束日期（YYYY-MM-DD，映射 before_date）
 * @property {number} [maxResults] 来源数量上限（客户端裁剪）
 * @property {string[]} [includeDomains] 域名白名单（映射 include_domains）
 * @property {string[]} [excludeDomains] 域名黑名单（映射 exclude_domains）
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'tinyfish'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string, publishedDate?: string}>} results 结果列表
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
 * 从 deps 解析 Tinyfish 密钥与搜索地址。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveTinyfish(deps) {
  // 扁平读取，兼容大小写环境变量名，空串视为缺失。
  const apiKey =
    (deps && (deps.tinyfishApiKey || deps.tinyfishKey || deps.TINYFISH_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 TINYFISH_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.searchUrlTinyfish || deps.tinyfishSearchUrl)) || DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * 域名数组归一为逗号分隔串。
 * @param {unknown} value 域名白/黑名单（数组或字符串）
 * @returns {string|undefined} 逗号分隔串，无效时回 undefined
 */
function joinDomains(value) {
  if (Array.isArray(value)) {
    const cleaned = value.filter((d) => typeof d === 'string' && d.trim()).map((d) => String(d).trim());
    return cleaned.length > 0 ? cleaned.join(',') : undefined;
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

/**
 * Tinyfish 搜索。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 tinyfishApiKey、searchUrlTinyfish）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function tinyfishSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = (params && params.query) || '';
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveTinyfish(deps);

  // 组装查询串：仅透传非空可选字段。
  const search = new URLSearchParams();
  search.set('query', query.trim());

  // 日期上下界：统一 fromDate/toDate 与原生 after_date/before_date 互认。
  const afterDate = (params && (params.fromDate || params.after_date || params.afterDate)) || '';
  const beforeDate = (params && (params.toDate || params.before_date || params.beforeDate)) || '';
  if (typeof afterDate === 'string' && afterDate) search.set('after_date', afterDate);
  if (typeof beforeDate === 'string' && beforeDate) search.set('before_date', beforeDate);

  // 新鲜度窗口：与日期上下界互斥，有日期界限时丢弃，避免上游 400。
  const recency = (params && (params.recencyMinutes ?? params.recency_minutes)) ?? undefined;
  if ((afterDate || beforeDate) === '' || (!afterDate && !beforeDate)) {
    if (Number.isInteger(recency)) search.set('recency_minutes', String(recency));
    else if (typeof recency === 'string' && recency.trim()) search.set('recency_minutes', recency.trim());
  }

  // 地理与语言：透传上游原生字段，缺省由上游自动解析（默认 US/en）。
  const location = (params && params.location) || '';
  const language = (params && params.language) || '';
  if (typeof location === 'string' && location) search.set('location', location);
  if (typeof language === 'string' && language) search.set('language', language);

  // 域名白/黑名单：统一数组与原生逗号串互认。
  const includeDomains = joinDomains(params && (params.includeDomains ?? params.include_domains));
  const excludeDomains = joinDomains(params && (params.excludeDomains ?? params.exclude_domains));
  if (includeDomains) search.set('include_domains', includeDomains);
  if (excludeDomains) search.set('exclude_domains', excludeDomains);

  // 内容类型：仅透传合法枚举。
  const domainType = (params && (params.domainType || params.domain_type)) || '';
  if (typeof domainType === 'string' && ALLOWED_DOMAIN_TYPES.has(domainType)) {
    search.set('domain_type', domainType);
  }

  // 搜索意图：短语或句子，原样透传。
  const purpose = (params && params.purpose) || '';
  if (typeof purpose === 'string' && purpose) search.set('purpose', purpose);

  const endpoint = url + '?' + search.toString();

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
      },
    });
  } catch (cause) {
    // 网络层异常视为可重试的上游不可用。
    throw fail('UPSTREAM_UNAVAILABLE', 'Tinyfish 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Tinyfish 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Tinyfish 搜索配额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 限速超限（每分 30 次/每时 500 次）：可重试，由调用方退避换源。
    throw fail('UPSTREAM_RATE_LIMITED', 'Tinyfish 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 408 || res.status === 503;
    throw fail('UPSTREAM_ERROR', 'Tinyfish 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();
  const items = Array.isArray(data && data.results) ? data.results : [];

  let results = items
    .filter((/** @type {any} */ item) => item && item.url)
    .map((/** @type {any} */ item) => {
      // 归一对象需动态追加 publishedDate，压为 any，避免缺失字段报错。
      const out = /** @type {any} */ ({
        title: String(item.title || item.site_name || item.url || ''),
        url: String(item.url || ''),
        content: String(item.snippet || item.content || item.text || ''),
      });
      const published = item.date || item.published_date || item.publishedDate;
      if (typeof published === 'string' && published) out.publishedDate = published;
      return out;
    });

  // 上游无条数参数，客户端按 maxResults 裁剪。
  const maxResults = params && params.maxResults;
  if (Number.isFinite(maxResults)) {
    const limit = Math.max(1, Math.min(50, Math.trunc(/** @type {number} */ (maxResults))));
    results = results.slice(0, limit);
  }

  /** @type {UnifiedSearchResult} */
  const out = { provider: 'tinyfish', results, raw: data };
  return out;
}
