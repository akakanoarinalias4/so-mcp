/**
 * Exa 抓取供应商（批量抓取，统一抓取形状适配层）。
 *
 * 上游：POST https://api.exa.ai/contents，请求头 x-api-key。
 * 语义：ids 承载 URL 列表，单批上限 100 条；results[] 承载内容，
 * statuses[] 逐 URL 结算成功失败（搜索附带内容前 10 免费，超出按页计费）。
 * 内容三形态：text（正文 markdown）、highlights（相关片段）、summary
 * （模型生成摘要），单请求宜只选一种，多选会分别计费。
 * 新鲜度：maxAgeHours 控制缓存/ fresh 抓取（0 恒鲜活，-1 仅缓存，
 * 缺省按需抓取）；subpages 跟随子页面。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认抓取端点（deps.fetchUrlExa 优先）。
const DEFAULT_FETCH_URL = 'https://api.exa.ai/contents';

// 上游单批上限（网关语义为 10 条，恒为单片；保留分片以兼容直调）。
const BATCH_LIMIT = 100;

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
 * 从 deps 解析 Exa 密钥与抓取地址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveExa(deps) {
  const apiKey =
    (deps && (deps.exaApiKey || deps.exaKey || deps.EXA_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 EXA_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlExa || deps.exaFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 判定包内单条失败是否可重试：失败计费未知，默认按可重试处理；
 * 仅明确不可重试（鉴权/余额/404/非法参数）时返回 false。
 * @param {string} error 上游错误文本
 * @returns {boolean} 是否可重试
 */
function isItemRetryable(error) {
  const text = String(error || '').toLowerCase();
  if (!text) return true;
  // 明确不可重试：鉴权、余额、未找到、非法 URL。
  if (
    text.includes('401') ||
    text.includes('403') ||
    text.includes('402') ||
    text.includes('404') ||
    text.includes('not found') ||
    text.includes('invalid url') ||
    text.includes('invalid id')
  ) {
    return false;
  }
  return true;
}

/**
 * 按固定大小切分数组。
 * @param {string[]} list 原数组
 * @param {number} size 分片大小
 * @returns {string[][]} 分片结果
 */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 从单条内容拼装正文：text > highlights > summary。
 * @param {any} item 上游单条内容
 * @returns {string} 归一正文
 */
function pickContent(item) {
  if (!item) return '';
  if (typeof item.text === 'string' && item.text) return item.text;
  if (Array.isArray(item.highlights) && item.highlights.length > 0) {
    return item.highlights.map((/** @type {any} */ h) => String(h)).join('\n\n[...] \n\n');
  }
  if (typeof item.summary === 'string' && item.summary) return item.summary;
  if (typeof item.content === 'string' && item.content) return item.content;
  return '';
}

/**
 * Exa 批量抓取。
 * @param {{urls: string[], format?: string, query?: string, highlights?: any, summary?: any, text?: any, subpages?: number, subpageTarget?: string[], subpage_target?: string[], maxAgeHours?: number, max_age_hours?: number, livecrawlTimeout?: number, maxCharacters?: number, ttl?: number, perUrlTimeoutMs?: number}} params
 *   统一抓取输入（urls 1..10；format 选 text/highlights/summary；
 *   query 供 highlights/summary 聚焦；subpages/maxAgeHours 新鲜度；
 *   perUrlTimeoutMs 映射 livecrawlTimeout）
 * @param {any} deps 依赖（含 exaApiKey、fetchUrlExa、fetchImpl）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string, publishedDate?: string}>, errors: Array<{url: string, error: string, retryable: boolean, status?: number}>, usage?: any}>}
 *   归一后的成功与失败列表（usage 透出 costDollars）
 */
export async function exaFetch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const urls = params && params.urls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 10) {
    throw fail('INVALID_PARAMS', 'urls 必须为 1..10 个 URL 的数组');
  }
  for (const u of urls) {
    if (typeof u !== 'string' || !(u.startsWith('http://') || u.startsWith('https://'))) {
      throw fail('INVALID_PARAMS', 'urls 仅支持 http/https 字符串：' + String(u));
    }
  }
  const { apiKey, url } = resolveExa(deps);

  // 内容形态：显式 highlights/summary 优先，其次 format 档位，默认 text。
  const query = typeof params.query === 'string' && params.query.trim() ? params.query : undefined;
  let wantHighlights = params.highlights !== undefined ? params.highlights : params.format === 'highlights';
  let wantSummary = params.summary !== undefined ? params.summary : params.format === 'summary';
  const wantText = !wantHighlights && !wantSummary;

  // 子页面跟随：钳制为非负整数，仅显式传入时透传。
  let subpages;
  if (params.subpages !== undefined) {
    const n = Number(params.subpages);
    if (Number.isFinite(n) && n >= 0) subpages = Math.trunc(n);
  }
  const subpageTarget = params.subpageTarget ?? params.subpage_target;
  // 新鲜度：显式 maxAgeHours 优先（允许 -1/0），缺省不传（按需抓取）。
  let maxAgeHours;
  const ageRaw = params.maxAgeHours ?? params.max_age_hours;
  if (ageRaw !== undefined) {
    const n = Number(ageRaw);
    if (Number.isFinite(n)) maxAgeHours = n;
  }
  // fresh 抓取超时：perUrlTimeoutMs 映射为 livecrawlTimeout（毫秒）。
  let livecrawlTimeout;
  if (params.livecrawlTimeout !== undefined) {
    const n = Number(params.livecrawlTimeout);
    if (Number.isFinite(n) && n > 0) livecrawlTimeout = Math.trunc(n);
  } else if (params.perUrlTimeoutMs !== undefined) {
    const n = Number(params.perUrlTimeoutMs);
    if (Number.isFinite(n) && n > 0) livecrawlTimeout = Math.trunc(n);
  }

  const batches = chunk(urls, BATCH_LIMIT);
  /** @type {any[]} */
  const results = [];
  /** @type {any[]} */
  const errors = [];
  let usage;

  for (const batch of batches) {
    // 上游请求体动态组装，压 any 避免隐式报错。
    const body = /** @type {any} */ ({ ids: batch });
    if (wantText) {
      // 文本形态：默认全量，maxCharacters 显式传入时截断。
      if (params.maxCharacters !== undefined) {
        const n = Number(params.maxCharacters);
        body.text = Number.isFinite(n) && n > 0 ? { maxCharacters: Math.trunc(n) } : true;
      } else if (params.text !== undefined && typeof params.text === 'object' && params.text !== null) {
        body.text = params.text;
      } else {
        body.text = true;
      }
    }
    if (wantHighlights) {
      // 高亮形态：true 或透传对象，query 有值时补齐聚焦。
      if (wantHighlights === true) {
        body.highlights = query !== undefined ? { query } : true;
      } else if (typeof wantHighlights === 'object' && wantHighlights !== null) {
        body.highlights = wantHighlights;
        if (query !== undefined && body.highlights.query === undefined) body.highlights.query = query;
      } else {
        body.highlights = wantHighlights;
      }
    }
    if (wantSummary) {
      // 摘要形态：同高亮，query 有值时补齐。
      if (wantSummary === true) {
        body.summary = query !== undefined ? { query } : true;
      } else if (typeof wantSummary === 'object' && wantSummary !== null) {
        body.summary = wantSummary;
        if (query !== undefined && body.summary.query === undefined) body.summary.query = query;
      } else {
        body.summary = wantSummary;
      }
    }
    if (subpages !== undefined) body.subpages = subpages;
    if (Array.isArray(subpageTarget) && subpageTarget.length > 0) body.subpageTarget = subpageTarget;
    if (maxAgeHours !== undefined) body.maxAgeHours = maxAgeHours;
    if (livecrawlTimeout !== undefined) body.livecrawlTimeout = livecrawlTimeout;

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
      throw fail(
        'UPSTREAM_UNAVAILABLE',
        'Exa 抓取请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause),
        { retryable: true },
      );
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
      throw fail('UPSTREAM_RATE_LIMITED', 'Exa 限流（429）', {
        status: 429,
        retryable: true,
      });
    }
    if (!res.ok) {
      throw fail('UPSTREAM_ERROR', 'Exa 抓取异常：HTTP ' + res.status, {
        status: res.status,
        retryable: res.status === 408 || res.status >= 500,
      });
    }

    const data = /** @type {any} */ (await res.json());
    const rawResults = Array.isArray(data && data.results) ? data.results : [];
    const rawStatuses = Array.isArray(data && data.statuses) ? data.statuses : [];
    // 计费透出：costDollars 为主，兼容 usage 字段。
    if (data && data.costDollars !== undefined) usage = { costDollars: data.costDollars };
    else if (data && data.usage !== undefined) usage = data.usage;

    // 状态表按 id 建索引，逐 URL 结算成功失败。
    /** @type {Map<string, any>} */
    const statusById = new Map();
    for (const /** @type {any} */ st of rawStatuses) {
      const key = String(st.id || st.url || '');
      if (key && !statusById.has(key)) statusById.set(key, st);
    }
    /** @type {Set<string>} */
    const settled = new Set();

    for (const /** @type {any} */ item of rawResults) {
      const key = String(item.url || item.id || '');
      if (!key) continue;
      const st = statusById.get(key);
      const statusText = String((st && (st.status || st.error)) || 'success').toLowerCase();
      settled.add(key);
      if (st && statusText !== 'success') {
        const message = String(st.error || st.status || 'fetch_failed');
        errors.push({ url: key, error: message, retryable: isItemRetryable(message) });
        continue;
      }
      // 成功条目归一，publishedDate 存在才追加。
      const out = /** @type {any} */ ({
        url: key,
        finalUrl: String(item.url || item.id || key),
        title: String(item.title || ''),
        content: String(pickContent(item) || ''),
      });
      const published = item.publishedDate || item.published_date;
      if (typeof published === 'string' && published) out.publishedDate = published;
      results.push(out);
    }

    // 有状态无内容：失败分项补齐。
    for (const /** @type {any} */ st of rawStatuses) {
      const key = String(st.id || st.url || '');
      if (!key || settled.has(key)) continue;
      const statusText = String(st.status || '').toLowerCase();
      if (statusText === 'success') continue;
      const message = String(st.error || st.status || 'fetch_failed');
      errors.push({ url: key, error: message, retryable: isItemRetryable(message) });
    }
  }

  const out = /** @type {any} */ ({ results, errors });
  if (usage !== undefined) out.usage = usage;
  return out;
}
