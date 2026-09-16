/**
 * HasData 搜索供应商（统一搜索形状适配层）。
 *
 * 计费（已核对 https://hasdata.com/prices 与 https://docs.hasdata.com/basics/pricing.md、
 * https://docs.hasdata.com/credits-and-concurrency.md）：
 * - 按成功请求扣点：通用抓取 1 点、专用接口 5 点、搜索全量 10 点、搜索轻量 5 点；
 *   本适配优先走 Google SERP Light（5 点）省点。
 * - 免费约 1000 点/月、单并发（免费账号限 1 并发），按保守一次性试用建模，不做排队假设。
 * - 失败不计费（仅 200 + status:"ok" 扣点，空结果集也扣点；400/5xx 等失败自动退点），
 *   因此失败可安全重试；余额耗尽回 403（ HasData 用 403 表示点数用尽）。
 * 上游：GET https://api.hasdata.com/scrape/google-light/serp，请求头 x-api-key。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点：SERP Light（5 点/次，比全量 SERP 的 10 点省一半）。
const DEFAULT_SEARCH_URL = 'https://api.hasdata.com/scrape/google-light/serp';

/** SERP Light 单次点数估算（全量 10 点，轻量 5 点）。 */
const SERP_LIGHT_CREDITS = 5;

// 上游 num 参数范围 10..100；小于 10 时按 10 取回再截断。
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;


/**
 * 统一搜索输入（网关形态，兼容别名）。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {'flash'|'fast'|'standard'|'deep'} [depth] 检索深度（本适配仅作默认条数参考）
 * @property {'searchResults'|'sourcedAnswer'|'structured'} [outputType] 输出形态（本适配恒为 searchResults）
 * @property {string} [fromDate] 起始日期（ISO，如 2024-01-01）
 * @property {string} [toDate] 结束日期（ISO）
 * @property {number} [maxResults] 来源数量上限
 * @property {number} [numResults] maxResults 别名
 * @property {string} [startPublishedDate] fromDate 别名
 * @property {string} [endPublishedDate] toDate 别名
 * @property {string} [location] 地理位置透传（如 Austin,Texas,United States）
 * @property {string[]} [includeDomains] 域名白名单
 * @property {string[]} [excludeDomains] 域名黑名单
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'hasdata'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string, publishedDate?: string, score?: number}>} results 结果列表
 * @property {string} [answer] 答案（命中 AI 概览/答框时）
 * @property {unknown} [raw] 上游原始响应
 * @property {{endpoint: string, creditsEstimated: number, requested: number, returned: number}} [usage] 点数估算
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
 * 从 deps 解析 HasData 密钥与搜索地址（扁平读取，兼容大写环境变量名，空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveHasdata(deps) {
  const apiKey =
    (deps &&
      (deps.hasdataApiKey ||
        deps.hasdataKey ||
        deps.HASDATA_API_KEY ||
        deps.HASDATA_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 HASDATA_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.searchUrlHasdata || deps.hasdataSearchUrl)) || DEFAULT_SEARCH_URL;
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
 * ISO 日期转 Google tbs 需要的 M/D/YYYY（去前导零）。
 * @param {string} iso ISO 日期
 * @returns {string} M/D/YYYY
 */
function toUsDate(iso) {
  const [y, m, d] = iso.split('-').map((part) => String(Number.parseInt(part, 10)));
  return `${m}/${d}/${y}`;
}

/**
 * 起止日期拼 Google tbs 自定义区间过滤。
 * @param {string|undefined} from 起始日期
 * @param {string|undefined} to 结束日期
 * @returns {string|undefined} tbs 参数，无合法日期时 undefined
 */
function buildTbs(from, to) {
  const hasFrom = isIsoDate(from);
  const hasTo = isIsoDate(to);
  if (!hasFrom && !hasTo) return undefined;
  const parts = ['cdr:1'];
  if (hasFrom) parts.push(`cd_min:${toUsDate(/** @type {string} */ (from))}`);
  if (hasTo) parts.push(`cd_max:${toUsDate(/** @type {string} */ (to))}`);
  return parts.join(',');
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
 * 域名白/黑名单折成 Google 查询语法拼到 q 上。
 * 白名单用 (site:a OR site:b)，黑名单用 -site:c -site:d；两者并存时白名单优先。
 * @param {string} query 原查询
 * @param {string[]} include 白名单
 * @param {string[]} exclude 黑名单
 * @returns {string} 拼装后的查询
 */
function applyDomains(query, include, exclude) {
  const inc = (Array.isArray(include) ? include : []).map(cleanDomain).filter(Boolean);
  const exc = (Array.isArray(exclude) ? exclude : []).map(cleanDomain).filter(Boolean);
  let out = query;
  if (inc.length > 0) {
    out += ` (${inc.map((d) => `site:${d}`).join(' OR ')})`;
  } else if (exc.length > 0) {
    out += ` ${exc.map((d) => `-site:${d}`).join(' ')}`;
  }
  return out;
}

/**
 * 从上游响应收集可映射条目：自然结果优先，新闻/头条拼接补量。
 * @param {any} data 上游 JSON
 * @returns {any[]} 原始条目数组
 */
function collectItems(data) {
  if (!data || typeof data !== 'object') return [];
  const buckets = [
    data.organicResults,
    data.topStories,
    data.newsResults,
    data.results,
    data.items,
  ];
  const out = [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket)) {
      for (const item of bucket) {
        if (item && typeof item === 'object') out.push(item);
      }
    }
  }
  return out;
}

/**
 * 提取 AI 概览/答框文本作 answer。
 * @param {any} data 上游 JSON
 * @returns {string|undefined} 答案文本，无命中时 undefined
 */
function pickAnswer(data) {
  if (!data || typeof data !== 'object') return undefined;
  const candidates = [
    data.answer,
    data.aiOverview,
    data.answerBox,
    data.knowledgeGraph,
  ];
  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim()) return cand.trim();
    if (cand && typeof cand === 'object') {
      const text = cand.text || cand.snippet || cand.answer || cand.description;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  return undefined;
}

/**
 * HasData 搜索：优先 Google SERP Light（5 点/次）。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 hasdataApiKey、searchUrlHasdata、fetchImpl）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function hasdataSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = params && params.query;
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveHasdata(deps);

  // 条数：兼容 numResults 别名；钳制 1..100，上游 num 最小 10，不足时取回再截断。
  const wantedRaw =
    (params && (params.maxResults ?? params.numResults)) ?? 10;
  const wanted =
    Number.isSafeInteger(wantedRaw) && wantedRaw > 0
      ? Math.min(wantedRaw, MAX_PAGE_SIZE)
      : 10;
  const num = Math.max(wanted, MIN_PAGE_SIZE);

  // 日期：兼容 startPublishedDate/endPublishedDate 别名，折成 tbs 自定义区间。
  const from = params && (params.fromDate ?? params.startPublishedDate);
  const to = params && (params.toDate ?? params.endPublishedDate);
  const tbs = buildTbs(
    typeof from === 'string' ? from : undefined,
    typeof to === 'string' ? to : undefined,
  );

  // 查询拼装：域名名单折成 site 语法（上游无原生域名参数）。
  const finalQuery = applyDomains(
    query.trim(),
    params && params.includeDomains,
    params && params.excludeDomains,
  );

  // 组装 GET 查询串，仅透传非空可选字段。
  const qs = new URLSearchParams({ q: finalQuery, num: String(num) });
  if (tbs) qs.set('tbs', tbs);
  if (params && typeof params.location === 'string' && params.location.trim()) {
    qs.set('location', params.location.trim());
  }
  const requestUrl = `${url}?${qs.toString()}`;

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(requestUrl, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    });
  } catch (cause) {
    // 网络层异常：失败不扣点，可安全重试。
    throw fail(
      'UPSTREAM_UNAVAILABLE',
      'HasData 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause),
      { retryable: true },
    );
  }

  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'HasData 密钥无效', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 403) {
    // HasData 以 403 表示点数耗尽：余额不足，不可重试。
    throw fail('INSUFFICIENT_CREDIT', 'HasData 点数耗尽（403）', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'HasData 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 422) {
    throw fail('INVALID_PARAMS', 'HasData 参数校验失败（422）', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 并发超限（免费单并发）：失败不扣点，退避后可重试。
    throw fail('UPSTREAM_RATE_LIMITED', 'HasData 并发超限（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status === 400 || res.status === 408 || res.status >= 500;
    throw fail('UPSTREAM_ERROR', 'HasData 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();
  // 包体 status 非 ok 且无可用条目：视为失败（不扣点），可安全重试。
  const items = collectItems(data);
  if (items.length === 0 && data && typeof data.error === 'string' && data.error) {
    throw fail('UPSTREAM_ERROR', 'HasData 搜索未返回可用结果：' + data.error, {
      status: res.status,
      retryable: true,
    });
  }

  const results = items
    .filter((item) => item && (item.link || item.url))
    .slice(0, wanted)
    .map((item) => {
      // 归一输出需按需追加 publishedDate/score，压为 any，避免缺失字段报错。
      const out = /** @type {any} */ ({
        title: String(item.title || item.source || item.link || item.url || ''),
        url: String(item.link || item.url || ''),
        content: String(item.snippet || item.description || item.text || ''),
      });
      const published = item.date || item.publishedDate || item.published_date;
      if (typeof published === 'string' && published) out.publishedDate = published;
      if (typeof item.score === 'number') out.score = item.score;
      return out;
    });

  /** @type {UnifiedSearchResult} */
  const out = {
    provider: 'hasdata',
    results,
    raw: data,
    usage: {
      endpoint: 'serp-light',
      creditsEstimated: SERP_LIGHT_CREDITS,
      requested: wanted,
      returned: results.length,
    },
  };
  const answer = pickAnswer(data);
  if (answer) out.answer = answer;
  return out;
}
