/**
 * Exa 搜索供应商（统一搜索形状适配层）。
 *
 * 上游：POST https://api.exa.ai/search，请求头 x-api-key。
 * 官方文档与定价（已抓取正文确认）：
 * - 免费额度：新账户赠送 $20（约 2800 次搜索），免费档每月再送 $10。
 * - 速度档 type：instant（约 250ms，实时路径）/ fast（约 450ms，低延迟）
 *   / auto（默认，质量速度均衡）/ deep-lite（约 4s，$12/1k）
 *   / deep（4-15s，$12/1k）/ deep-reasoning（12-40s，$15/1k）；
 *   outputSchema 全档可用，叠加约 2s 合成延迟。
 * - 内容形态 contents：text（正文）/ highlights（相关片段，默认推荐）
 *   / summary（逐页模型调用）；单请求宜只选一种，多选分别计费。
 * - 计费：/search $7/1k（含前 10 results），超 10 部分 $1/1k results；
 *   附带内容前 10 页免费、超出按页计费，故 usage 必须透出。
 * - 语言限制：无 language 参数，只有 userLocation（ISO 国家码），不在网关统一输入内。
 * 类目约束（违例上游直接 400，本适配前置拦截）：
 * - company / people 类目不支持 startPublishedDate / endPublishedDate / excludeDomains；
 * - people 类目 includeDomains 仅限领英系（linkedin.com 及其子域）。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认搜索端点（deps.searchUrlExa 优先）。
const DEFAULT_SEARCH_URL = 'https://api.exa.ai/search';

/** 网关 depth 到 Exa type 的映射。 */
const DEPTH_MAP = {
  flash: 'instant',
  fast: 'fast',
  standard: 'auto',
  deep: 'deep',
};

/** 合法的 Exa 搜索档（含深度研究档，原生 type 可直传覆盖）。 */
const ALLOWED_TYPES = new Set([
  'instant',
  'fast',
  'auto',
  'deep-lite',
  'deep',
  'deep-reasoning',
]);

/** 日期与黑名单受限类目。 */
const RESTRICTED_CATEGORIES = new Set(['company', 'people']);

/**
 * 统一搜索输入。
 * @typedef {object} UnifiedSearchParams
 * @property {string} query 查询文本
 * @property {'flash'|'fast'|'standard'|'deep'} [depth] 检索深度
 * @property {'searchResults'|'sourcedAnswer'|'structured'} [outputType] 输出形态
 * @property {string} [fromDate] 起始日期（统一 YYYY-MM-DD）
 * @property {string} [toDate] 结束日期（统一 YYYY-MM-DD）
 * @property {number} [maxResults] 来源数量上限（统一档，钳制 1..50）
 * @property {string[]} [includeDomains] 域名白名单
 * @property {string[]} [excludeDomains] 域名黑名单
 */

/**
 * 统一搜索输出。
 * @typedef {object} UnifiedSearchResult
 * @property {'exa'} provider 供应商名
 * @property {Array<{title: string, url: string, content: string}>} results 结果列表
 * @property {string} [answer] 答案（outputSchema 合成时）
 * @property {unknown} [raw] 上游原始响应
 * @property {unknown} [usage] 计费用量（costDollars）
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
 * 从 deps 解析 Exa 密钥与搜索地址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveExa(deps) {
  // 扁平读取，兼容大小写环境变量名，空串视为缺失。
  const apiKey =
    (deps && (deps.exaApiKey || deps.exaKey || deps.EXA_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 EXA_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.searchUrlExa || deps.exaSearchUrl)) || DEFAULT_SEARCH_URL;
  return { apiKey, url };
}

/**
 * 钳制条数为整数区间，非法回默认。
 * @param {unknown} value 输入值
 * @param {number} lo 下界（含）
 * @param {number} hi 上界（含）
 * @param {number} fallback 非法时的默认值
 * @returns {number} 钳制后的条数
 */
function clampCount(value, lo, hi, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(/** @type {number} */ (value));
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 解析请求条数：统一 maxResults 钳制 1..50，原生 numResults/num_results 透传时不超过 100。
 * @param {any} params 统一搜索输入（含原生字段）
 * @returns {number} 上游 numResults
 */
function resolveNumResults(params) {
  if (params && params.maxResults !== undefined) {
    return clampCount(params.maxResults, 1, 50, 10);
  }
  const native = params && (params.numResults ?? params.num_results);
  if (native !== undefined) return clampCount(native, 1, 100, 10);
  return 10;
}

/**
 * 归一域名列表为字符串数组。
 * @param {unknown} value 数组或单串
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
 * 归一日期为 ISO 时间：网关 YYYY-MM-DD 补齐为日期时间，原生 ISO 原样透传。
 * @param {unknown} value 日期输入
 * @returns {string|undefined} ISO 日期时间，无效时回 undefined
 */
function toPublishedDate(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  // 网关统一形态为 YYYY-MM-DD，上游要求 ISO 8601 date-time，补齐午夜 UTC。
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text + 'T00:00:00.000Z';
  return text;
}

/**
 * 判定域名是否属于领英系（linkedin.com 及其子域）。
 * @param {string} domain 白名单条目（可带协议/路径/通配符）
 * @returns {boolean} 是否领英系
 */
function isLinkedInDomain(domain) {
  const host = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/^\*\./, '')
    .split(':')[0];
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

/**
 * 前置校验类目约束：company/people 禁日期与黑名单，people 白名单仅限领英系，违例 400。
 * @param {string|undefined} category 类目
 * @param {boolean} hasDate 是否携带日期过滤
 * @param {string[]|undefined} includeDomains 白名单
 * @param {string[]|undefined} excludeDomains 黑名单
 */
function checkCategoryConstraints(category, hasDate, includeDomains, excludeDomains) {
  if (!category) return;
  const name = category.toLowerCase();
  if (!RESTRICTED_CATEGORIES.has(name)) return;
  if (hasDate) {
    throw fail('INVALID_PARAMS', 'Exa ' + category + ' 类目不支持日期过滤', {
      status: 400,
      retryable: false,
    });
  }
  if (excludeDomains) {
    throw fail('INVALID_PARAMS', 'Exa ' + category + ' 类目不支持 excludeDomains', {
      status: 400,
      retryable: false,
    });
  }
  if (name === 'people' && includeDomains) {
    const bad = includeDomains.filter((d) => !isLinkedInDomain(d));
    if (bad.length > 0) {
      throw fail('INVALID_PARAMS', 'Exa people 类目白名单仅限领英系域名：' + bad.join(', '), {
        status: 400,
        retryable: false,
      });
    }
  }
}

/**
 * 从单条结果拼装正文：highlights 数组拼接优先，其次 text，最后 summary。
 * @param {any} item 上游单条结果
 * @returns {string} 归一正文
 */
function pickContent(item) {
  if (Array.isArray(item.highlights) && item.highlights.length > 0) {
    return item.highlights.map((h) => String(h || '')).filter(Boolean).join('\n');
  }
  if (typeof item.text === 'string' && item.text) return item.text;
  if (typeof item.summary === 'string' && item.summary) return item.summary;
  return '';
}

/**
 * Exa 搜索。
 * @param {UnifiedSearchParams} params 统一搜索输入
 * @param {any} deps 依赖（含 exaApiKey、searchUrlExa、fetchImpl）
 * @returns {Promise<UnifiedSearchResult>} 统一搜索输出
 */
export async function exaSearch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const query = (params && params.query) || '';
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_PARAMS', 'query 必填且为非空字符串');
  }
  const { apiKey, url } = resolveExa(deps);

  // 速度档：原生 type 合法时直传（可覆盖 deep-lite/deep-reasoning），否则按网关 depth 映射。
  const nativeType = params && params.type;
  const depth = (params && params.depth) || '';
  const type =
    (typeof nativeType === 'string' && ALLOWED_TYPES.has(nativeType) && nativeType) ||
    DEPTH_MAP[depth] ||
    'auto';

  // 类目：原生 category 透传（大小写不敏感校验），违例前置抛 400。
  const rawCategory = params && params.category;
  const category =
    typeof rawCategory === 'string' && rawCategory.trim() ? rawCategory.trim() : undefined;
  const includeDomains = normalizeDomains(
    params && (params.includeDomains ?? params.include_domains),
  );
  const excludeDomains = normalizeDomains(
    params && (params.excludeDomains ?? params.exclude_domains),
  );
  const startPublishedDate = toPublishedDate(
    params && (params.fromDate ?? params.startPublishedDate ?? params.start_published_date),
  );
  const endPublishedDate = toPublishedDate(
    params && (params.toDate ?? params.endPublishedDate ?? params.end_published_date),
  );
  checkCategoryConstraints(category, Boolean(startPublishedDate || endPublishedDate), includeDomains, excludeDomains);

  // 上游请求体字段动态（可选字段按需透传），整体压为 any，避免隐式 any 报错。
  const body = /** @type {any} */ ({
    query: query.trim(),
    type,
    numResults: resolveNumResults(params),
  });
  if (category) body.category = category;
  if (includeDomains) body.includeDomains = includeDomains;
  if (excludeDomains) body.excludeDomains = excludeDomains;
  if (startPublishedDate) body.startPublishedDate = startPublishedDate;
  if (endPublishedDate) body.endPublishedDate = endPublishedDate;

  // 内容形态：调用方显式 contents 优先（单请求宜只选一种，多选分别计费）；
  // 缺省取 highlights 片段，兼顾相关性与 token 开销。
  const contents = params && params.contents;
  if (contents !== undefined && typeof contents === 'object' && contents !== null) {
    body.contents = contents;
  } else {
    body.contents = { highlights: true };
  }

  // 答案形态：原生 outputSchema 透传；sourcedAnswer 无显式 schema 时补默认文本合成。
  const outputSchema = params && params.outputSchema;
  if (outputSchema !== undefined && typeof outputSchema === 'object' && outputSchema !== null) {
    body.outputSchema = outputSchema;
  } else if (params && params.outputType === 'sourcedAnswer') {
    body.outputSchema = { type: 'text', description: '用检索结果回答查询，简明扼要' };
  }

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    // 网络层异常视为可重试的上游不可用。
    throw fail('UPSTREAM_UNAVAILABLE', 'Exa 搜索请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause), {
      retryable: true,
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Exa 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Exa 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    // 限流：可重试，由调用方退避或换源。
    throw fail('UPSTREAM_RATE_LIMITED', 'Exa 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status === 408 || res.status >= 500;
    throw fail('UPSTREAM_ERROR', 'Exa 搜索异常：HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  const data = await res.json();
  const items = Array.isArray(data && data.results) ? data.results : [];

  const results = items
    .filter((/** @type {any} */ item) => item && (item.url || item.id))
    .map((/** @type {any} */ item) => {
      // 归一对象需动态追加 publishedDate/score，压为 any，避免缺失字段报错。
      const out = /** @type {any} */ ({
        title: String(item.title || item.url || item.id || ''),
        url: String(item.url || item.id || ''),
        content: String(pickContent(item) || ''),
      });
      const published = item.publishedDate || item.published_date;
      if (typeof published === 'string' && published) out.publishedDate = published;
      if (Number.isFinite(item.score)) out.score = item.score;
      return out;
    });

  /** @type {UnifiedSearchResult} */
  const out = /** @type {UnifiedSearchResult} */ ({ provider: 'exa', results, raw: data });
  // 合成答案：outputSchema 返回的 output.content 落盘为 answer。
  const answer = data && data.output && data.output.content;
  if (typeof answer === 'string' && answer) out.answer = answer;
  // 计费透出：前 10 结果内容免费、超出按页计费，costDollars 为主，兼容 usage 字段。
  if (data && data.costDollars !== undefined) out.usage = { costDollars: data.costDollars };
  else if (data && data.usage !== undefined) out.usage = data.usage;
  return out;
}
