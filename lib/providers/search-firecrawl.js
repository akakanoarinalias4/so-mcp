/**
 * Firecrawl 搜索供应商（统一搜索形状适配层）。
 *
 * 计费（已核对 https://www.firecrawl.dev/pricing 与搜索文档正文
 * https://docs.firecrawl.dev/features/search、接口参考
 * https://docs.firecrawl.dev/api-reference/endpoint/search）：
 * - 搜索按量计点：每 10 结果计 2 点，向上取整（1~10 结果=2 点，11~20=4 点，依此类推）；
 *   本适配默认不带 scrapeOptions，只付搜索费，不触发按页抓取费。
 * - 免费每月 1000 点、无结转（仅 Scale/Enterprise 结转），耗尽回 402，不可重试。
 * - 状态轮询查询不计费（搜索为同步返回，无需轮询；若上游返回异步 jobId，查状态不扣点）。
 * - 失败计费：无文档返回的失败不计费；带文档但目标站 403/404 的条目仍计 1 点，
 *   因此映射时必须读每条 metadata.statusCode 做止损（403/404 条目直接丢弃，不纳入 results）。
 * 上游：POST https://api.firecrawl.dev/v2/search，请求头 Authorization: Bearer。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlFirecrawl / firecrawlSearchUrl 优先）。
const DEFAULT_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

// 深度档位到默认条数的映射（显式 maxResults/limit 优先）。
const DEPTH_DEFAULT_LIMIT = {
  flash: 5,
  fast: 10,
  standard: 10,
  deep: 20,
};

/**
 * 统一搜索输入（网关形态，兼容别名）。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {'flash'|'fast'|'standard'|'deep'} [depth] 检索深度（映射默认条数）
 * @property {'searchResults'|'sourcedAnswer'|'structured'} [outputType] 输出形态（本适配恒为 searchResults）
 * @property {string} [fromDate] 起始日期（ISO，如 2024-01-01）
 * @property {string} [toDate] 结束日期（ISO）
 * @property {number} [maxResults] 来源数量上限
 * @property {number} [limit] maxResults 别名（Firecrawl 原生名）
 * @property {string} [timeRange] tbs 别名（直接透传，如 qdr:d）
 * @property {string} [tbs] 时间过滤（直接透传，优先级高于 fromDate/toDate）
 * @property {string} [location] 地理位置（如 Germany / San Francisco,California,United States）
 * @property {string} [language] 语言/国家别名（2 位码或 locale，折成 country）
 * @property {string} [country] ISO 国家码（如 US）
 * @property {string[]} [includeDomains] 域名白名单
 * @property {string[]} [excludeDomains] 域名黑名单
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'firecrawl'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string, publishedDate?: string, score?: number}>} results 结果列表
 * @property {string} [answer] 答案（上游返回时透出）
 * @property {unknown} [raw] 上游原始响应
 * @property {{creditsEstimated: number, requested: number, returned: number, filtered: number, creditsUsed?: number}} [usage] 点数估算
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
 * 从 deps 解析 Firecrawl 密钥与搜索地址（扁平读取，兼容大写环境变量名，空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveFirecrawl(deps) {
  const apiKey =
    (deps &&
      (deps.firecrawlApiKey ||
        deps.firecrawlKey ||
        deps.FIRECRAWL_API_KEY ||
        deps.FIRECRAWL_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 FIRECRAWL_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.searchUrlFirecrawl || deps.firecrawlSearchUrl)) || DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * 是否为合法 ISO 日期（YYYY-MM-DD）。
 * @param {unknown} value 待检值
 * @returns {value is string} 是否合法
 */
function isIsoDate(value) {
  return (
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
  );
}

/**
 * ISO 日期转 tbs 需要的 M/D/YYYY（去前导零）。
 * @param {string} iso ISO 日期
 * @returns {string} M/D/YYYY
 */
function toUsDate(iso) {
  const [y, m, d] = iso.split('-').map((part) => String(Number.parseInt(part, 10)));
  return `${m}/${d}/${y}`;
}

/**
 * 起止日期拼 tbs 自定义区间；调用方显式 timeRange/tbs 优先直接透传。
 * @param {any} params 统一搜索输入
 * @returns {string|undefined} tbs 参数
 */
function buildTbs(params) {
  const direct = params && (params.tbs ?? params.timeRange);
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const from = params && params.fromDate;
  const to = params && params.toDate;
  const hasFrom = isIsoDate(from);
  const hasTo = isIsoDate(to);
  if (!hasFrom && !hasTo) return undefined;
  const parts = ['cdr:1'];
  if (hasFrom) parts.push(`cd_min:${toUsDate(/** @type {string} */ (from))}`);
  if (hasTo) parts.push(`cd_max:${toUsDate(/** @type {string} */ (to))}`);
  return parts.join(',');
}

/**
 * 语言/国家别名折成 ISO 国家码。
 * 2 位字母直接大写；locale（如 en-US、zh_CN）取区域段；其余常见语言码映射默认国家。
 * @param {any} params 统一搜索输入
 * @returns {string|undefined} 国家码，无可用时 undefined
 */
function buildCountry(params) {
  const raw = params && (params.country ?? params.language);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const text = raw.trim();
  // locale：取分隔符后的区域段。
  const regionMatch = text.match(/[-_]([A-Za-z]{2})$/);
  if (regionMatch) return regionMatch[1].toUpperCase();
  if (/^[A-Za-z]{2}$/.test(text)) {
    const upper = text.toUpperCase();
    // 纯语言码映射默认国家，避免把语言误当国家透传时走错地域。
    if (/^(EN|ZH|DE|FR|JA|KO|ES|PT|IT|RU|NL)$/.test(upper)) {
      const fallback = { EN: 'US', ZH: 'CN', DE: 'DE', FR: 'FR', JA: 'JP', KO: 'KR', ES: 'ES', PT: 'BR', IT: 'IT', RU: 'RU', NL: 'NL' };
      return /** @type {string} */ (fallback[upper] || upper);
    }
    return upper;
  }
  return undefined;
}

/**
 * 清洗域名条目：去协议头与路径，只留裸域。
 * @param {unknown} value 待清洗值
 * @returns {string} 裸域，非法时为空串
 */
function cleanDomain(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/^https?:\/\//i, '');
  const host = text.split('/')[0].trim().toLowerCase();
  if (!host || host.includes(' ') || !host.includes('.')) return '';
  return host;
}

/**
 * 每 10 结果计 2 点，向上取整。
 * @param {number} limit 请求条数
 * @returns {number} 估计点数
 */
function estimateCredits(limit) {
  return Math.ceil(limit / 10) * 2;
}

/**
 * Firecrawl 搜索：POST /v2/search，不带抓取选项以控制成本。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 firecrawlApiKey、searchUrlFirecrawl、fetchImpl）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function firecrawlSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = params && params.query;
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveFirecrawl(deps);

  // 条数：maxResults/limit/深度档位三级回退，钳制 1..50。
  const depthDefault =
    (params && params.depth && DEPTH_DEFAULT_LIMIT[params.depth]) || 10;
  const wantedRaw = (params && (params.maxResults ?? params.limit)) ?? depthDefault;
  const wanted =
    Number.isSafeInteger(wantedRaw) && wantedRaw > 0
      ? Math.min(Math.max(wantedRaw, MIN_LIMIT), MAX_LIMIT)
      : depthDefault;

  // 组装上游请求体，仅透传非空可选字段；不带 scrapeOptions，只付搜索费。
  const body = /** @type {any} */ ({ query: query.trim(), limit: wanted });
  const tbs = buildTbs(params);
  if (tbs) body.tbs = tbs;
  if (params && typeof params.location === 'string' && params.location.trim()) {
    body.location = params.location.trim();
  }
  const country = buildCountry(params);
  if (country) body.country = country;
  const include = (Array.isArray(params && params.includeDomains) ? params.includeDomains : [])
    .map(cleanDomain)
    .filter(Boolean);
  const exclude = (Array.isArray(params && params.excludeDomains) ? params.excludeDomains : [])
    .map(cleanDomain)
    .filter(Boolean);
  // 上游白/黑名单互斥：两者并存时白名单优先。
  if (include.length > 0) {
    body.includeDomains = include;
  } else if (exclude.length > 0) {
    body.excludeDomains = exclude;
  }

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
    // 网络层异常：无文档返回，不计费，可安全重试。
    throw fail(
      'UPSTREAM_UNAVAILABLE',
      'Firecrawl 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause),
      { retryable: true },
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Firecrawl 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    // 免费每月 1000 点无结转，耗尽回 402：余额不足，不可重试。
    throw fail('INSUFFICIENT_CREDIT', 'Firecrawl 点数耗尽（402）', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    throw fail('UPSTREAM_RATE_LIMITED', 'Firecrawl 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status === 408 || res.status >= 500;
    throw fail('UPSTREAM_ERROR', 'Firecrawl 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();
  if (data && data.success === false) {
    // 明确失败且无文档：不计费，可安全重试。
    const msg =
      (typeof data.error === 'string' && data.error) || 'Firecrawl 搜索失败';
    throw fail('UPSTREAM_ERROR', msg, { status: res.status, retryable: true });
  }

  const payload = data && typeof data === 'object' && data.data ? data.data : data;
  // v2 按来源分组：web/news/images；本适配只取可归一的 web + news。
  const web = payload && Array.isArray(payload.web) ? payload.web : [];
  const news = payload && Array.isArray(payload.news) ? payload.news : [];
  const fallback = payload && Array.isArray(payload) ? payload : [];
  const rawItems = [...web, ...news, ...fallback];

  let filtered = 0;
  const results = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const link = item.url || item.link;
    if (typeof link !== 'string' || !link) continue;
    // 止损：带文档但目标站 403/404 的条目仍计 1 点，直接丢弃，不纳入 results。
    const statusCode = item.metadata && item.metadata.statusCode;
    if (statusCode === 403 || statusCode === 404) {
      filtered += 1;
      continue;
    }
    // 归一输出需按需追加 publishedDate/score，压为 any，避免缺失字段报错。
    const out = /** @type {any} */ ({
      title: String(item.title || link),
      url: String(link),
      content: String(item.markdown || item.description || item.snippet || ''),
    });
    const published = item.date || item.publishedDate || item.published_date;
    if (typeof published === 'string' && published) out.publishedDate = published;
    if (typeof item.score === 'number') out.score = item.score;
    results.push(out);
    if (results.length >= wanted) break;
  }

  /** @type {UnifiedSearchResult} */
  const out = {
    provider: 'firecrawl',
    results,
    raw: data,
    usage: {
      creditsEstimated: estimateCredits(wanted),
      requested: wanted,
      returned: results.length,
      filtered,
    },
  };
  const creditsUsed =
    data && typeof data.creditsUsed === 'number' ? data.creditsUsed : undefined;
  if (creditsUsed !== undefined) out.usage.creditsUsed = creditsUsed;
  const answer = data && (data.answer ?? payload?.answer);
  if (typeof answer === 'string' && answer.trim()) out.answer = answer.trim();
  return out;
}
