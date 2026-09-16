/**
 * Tavily 搜索供应商（统一搜索形状适配层）。
 *
 * 上游：POST https://api.tavily.com/search，请求头 Authorization: Bearer。
 * 计费：基础档（ultra-fast/basic/fast）每请求 1 点，高级档（advanced）每请求 2 点。
 * 失败不计费仅抓取侧承诺，搜索侧按实际用量结算。
 * 职责：把 UnifiedSearch 输入映射为 Tavily 参数，把结果归一为 UnifiedSearch 输出。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlTavily 优先）。
const DEFAULT_SEARCH_URL = 'https://api.tavily.com/search';

/** 网关深度到 Tavily 深度的映射。 */
const DEPTH_MAP = {
  flash: 'ultra-fast',
  fast: 'basic',
  standard: 'basic',
  deep: 'advanced',
};

/** 允许的主题枚举。 */
const ALLOWED_TOPICS = new Set(['general', 'news', 'finance']);

/** 允许的时间窗口枚举。 */
const ALLOWED_TIME_RANGES = new Set(['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y']);

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {'flash'|'fast'|'standard'|'deep'} [depth] 检索深度
 * @property {'searchResults'|'sourcedAnswer'|'structured'} [outputType] 输出形态
 * @property {string} [fromDate] 起始日期（YYYY-MM-DD，映射 start_date）
 * @property {string} [toDate] 结束日期（YYYY-MM-DD，映射 end_date）
 * @property {number} [maxResults] 来源数量上限（映射 max_results，钳制 0..20）
 * @property {string[]} [includeDomains] 域名白名单（映射 include_domains）
 * @property {string[]} [excludeDomains] 域名黑名单（映射 exclude_domains）
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'tavily'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string, publishedDate?: string, score?: number}>} results 结果列表
 * @property {string} [answer] 答案（sourcedAnswer 时）
 * @property {unknown} [raw] 上游原始响应
 * @property {unknown} [usage] 上游用量信息
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
 * 从 deps 解析 Tavily 密钥与搜索地址。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveTavily(deps) {
  // 扁平读取，兼容大小写环境变量名，空串视为缺失。
  const apiKey =
    (deps && (deps.tavilyApiKey || deps.tavilyKey || deps.TAVILY_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 TAVILY_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.searchUrlTavily || deps.tavilySearchUrl)) || DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * 钳制 max_results 到 0..20，非法回默认 10。
 * @param {unknown} value 统一 maxResults 或原生 max_results
 * @returns {number} 钳制后的条数
 */
function clampMaxResults(value) {
  if (!Number.isFinite(value)) return 10;
  const n = Math.trunc(/** @type {number} */ (value));
  return Math.max(0, Math.min(20, n));
}

/**
 * 归一域名列表为字符串数组。
 * @param {unknown} value 数组或逗号串
 * @returns {string[]|undefined} 字符串数组，无效时回 undefined
 */
function normalizeDomains(value) {
  if (Array.isArray(value)) {
    const cleaned = value.filter((d) => typeof d === 'string' && d.trim());
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return undefined;
}

/**
 * Tavily 搜索。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 tavilyApiKey、searchUrlTavily）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function tavilySearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = (params && params.query) || '';
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveTavily(deps);

  // 深度映射：flash->ultra-fast，fast/standard->basic，deep->advanced。
  const depth = (params && params.depth) || '';
  const searchDepth = DEPTH_MAP[depth] || 'basic';

  // 条数钳制：统一 maxResults 与原生 max_results 互认，缺省 10。
  const rawMax = (params && (params.maxResults ?? params.max_results)) ?? 10;
  const maxResults = clampMaxResults(rawMax);

  // 上游请求体字段动态（可选字段按需透传），整体压为 any，避免隐式 any 报错。
  const body = /** @type {any} */ ({
    query: query.trim(),
    search_depth: searchDepth,
    max_results: maxResults,
  });

  // 主题：仅透传合法枚举。
  const topic = (params && params.topic) || '';
  if (typeof topic === 'string' && ALLOWED_TOPICS.has(topic)) body.topic = topic;

  // 时间窗口：仅透传合法枚举。
  const timeRange = (params && (params.timeRange || params.time_range)) || '';
  if (typeof timeRange === 'string' && ALLOWED_TIME_RANGES.has(timeRange)) {
    body.time_range = timeRange;
  }

  // 日期界限：统一 fromDate/toDate 与原生 start_date/end_date 互认。
  const startDate = (params && (params.fromDate || params.start_date || params.startDate)) || '';
  const endDate = (params && (params.toDate || params.end_date || params.endDate)) || '';
  if (typeof startDate === 'string' && startDate) body.start_date = startDate;
  if (typeof endDate === 'string' && endDate) body.end_date = endDate;

  // 域名白/黑名单：统一数组与原生字段互认。
  const includeDomains = normalizeDomains(params && (params.includeDomains ?? params.include_domains));
  const excludeDomains = normalizeDomains(params && (params.excludeDomains ?? params.exclude_domains));
  if (includeDomains) body.include_domains = includeDomains;
  if (excludeDomains) body.exclude_domains = excludeDomains;

  // 答案开关：outputType 为 sourcedAnswer 时开启 include_answer。
  if (params && params.outputType === 'sourcedAnswer') {
    body.include_answer = true;
  } else if (params && (params.include_answer !== undefined || params.includeAnswer !== undefined)) {
    body.include_answer = params.include_answer ?? params.includeAnswer;
  }

  // 原文透传：仅调用方显式要求时开启，避免增大延迟与响应体。
  if (params && (params.include_raw_content !== undefined || params.includeRawContent !== undefined)) {
    body.include_raw_content = params.include_raw_content ?? params.includeRawContent;
  }

  // 发布日期：恒开启以便归一 publishedDate，news 主题下上游自动启用。
  body.include_published_date = true;

  // 语言与国家：透传上游原生字段。
  const language = (params && params.language) || '';
  const country = (params && params.country) || '';
  if (typeof language === 'string' && language) body.language = language;
  if (typeof country === 'string' && country) body.country = country;

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
    throw fail('UPSTREAM_UNAVAILABLE', 'Tavily 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Tavily 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Tavily 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 限速超限：可重试，由调用方退避或换源。
    throw fail('UPSTREAM_RATE_LIMITED', 'Tavily 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 408;
    throw fail('UPSTREAM_ERROR', 'Tavily 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();
  const items = Array.isArray(data && data.results) ? data.results : [];

  const results = items
    .filter((/** @type {any} */ item) => item && (item.url || item.link))
    .map((/** @type {any} */ item) => {
      // 归一对象需动态追加 publishedDate/score，压为 any，避免缺失字段报错。
      const out = /** @type {any} */ ({
        title: String(item.title || item.url || item.link || ''),
        url: String(item.url || item.link || ''),
        content: String(item.content || item.snippet || item.raw_content || item.text || ''),
      });
      const published = item.published_date || item.publishedDate;
      if (typeof published === 'string' && published) out.publishedDate = published;
      if (Number.isFinite(item.score)) out.score = item.score;
      return out;
    });

  /** @type {UnifiedSearchResult} */
  const out = /** @type {UnifiedSearchResult} */ ({ provider: 'tavily', results, raw: data });
  // 答案写入 answer：仅非空字符串落盘。
  const answer = (data && data.answer) || undefined;
  if (typeof answer === 'string' && answer) out.answer = answer;
  // 用量透传：上游 include_usage 或默认用量字段原样回传。
  const usage = (data && (data.usage || data.response_usage)) || undefined;
  if (usage !== undefined) out.usage = usage;
  return out;
}
