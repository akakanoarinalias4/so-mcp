/**
 * Tavily 抓取供应商（批量抓取，统一抓取形状适配层）。
 *
 * 上游：POST https://api.tavily.com/extract，请求头 Authorization: Bearer。
 * 语义：单批上限 20 条（urls 1..20），成功进 results[]，单条失败进
 * failed_results[]，HTTP 200 也要同时检查两边；输出顺序不保证。
 * 计费：basic 档每 5 次成功 1 点，advanced 档每 5 次成功 2 点，
 * 失败永不计费（成功未满 5 次时 usage 可能为 0）。
 * query 用于对抽取分片做相关性重排；chunks_per_source 仅在 query
 * 存在时有效（1..5，默认 3），分片拼入 raw_content 字段。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认抓取端点（deps.fetchUrlTavily 优先）。
const DEFAULT_FETCH_URL = 'https://api.tavily.com/extract';

// 上游单批上限（网关语义为 10 条，超出时按 20 条分片再归一）。
const BATCH_LIMIT = 20;

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
 * 从 deps 解析 Tavily 密钥与抓取地址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveTavily(deps) {
  const apiKey =
    (deps && (deps.tavilyApiKey || deps.tavilyKey || deps.TAVILY_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 TAVILY_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlTavily || deps.tavilyFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 判定包内单条失败是否可重试（仅 5xx/408 为真）。
 * failed_results 只有 url + error 文本，从文本中嗅探状态码。
 * @param {string} error 上游错误文本
 * @returns {boolean} 是否可重试
 */
function isItemRetryable(error) {
  if (typeof error !== 'string' || !error) return false;
  const m = error.match(/\b(\d{3})\b/);
  if (!m) return false;
  const status = Number(m[1]);
  return status === 408 || (status >= 500 && status <= 599);
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
 * Tavily 批量抓取。
 * @param {{urls: string[], format?: string, query?: string, chunksPerSource?: number, chunks_per_source?: number, extractDepth?: string, extract_depth?: string, timeout?: number, perUrlTimeoutMs?: number, ttl?: number}} params
 *   统一抓取输入（urls 1..10；format 文本形态；query 重排意图；
 *   chunksPerSource 分片数；extractDepth 档位；timeout 秒 / perUrlTimeoutMs 毫秒）
 * @param {any} deps 依赖（含 tavilyApiKey、fetchUrlTavily、fetchImpl）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string}>, errors: Array<{url: string, error: string, retryable: boolean, status?: number}>, usage?: any}>}
 *   归一后的成功与失败列表（usage 为上游 credits 透出）
 */
export async function tavilyFetch(params, deps) {
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
  const { apiKey, url } = resolveTavily(deps);

  // 形态映射：text 透传 text，其余一律 markdown（上游仅支持 markdown/text）。
  const format = params.format === 'text' ? 'text' : 'markdown';
  // 档位映射：仅 basic/advanced，其余回退 basic。
  const depthRaw = params.extractDepth ?? params.extract_depth;
  const extractDepth = depthRaw === 'advanced' ? 'advanced' : 'basic';
  // 重排意图：非空字符串才透传。
  const query = typeof params.query === 'string' && params.query.trim() ? params.query : undefined;
  // 分片数：仅 query 存在时有效，钳制 1..5。
  let chunksPerSource;
  const chunksRaw = params.chunksPerSource ?? params.chunks_per_source;
  if (query !== undefined && chunksRaw !== undefined) {
    const n = Number(chunksRaw);
    if (Number.isFinite(n)) {
      chunksPerSource = Math.min(5, Math.max(1, Math.trunc(n)));
    }
  }
  // 超时：优先 timeout（秒），回退 perUrlTimeoutMs（毫秒），统一钳制 1..60 秒。
  let timeout;
  if (params.timeout !== undefined) {
    const t = Number(params.timeout);
    if (Number.isFinite(t)) timeout = Math.min(60, Math.max(1, t));
  } else if (params.perUrlTimeoutMs !== undefined) {
    const t = Number(params.perUrlTimeoutMs) / 1000;
    if (Number.isFinite(t)) timeout = Math.min(60, Math.max(1, t));
  }

  // 单批按 20 条分片（网关输入恒 <= 10，实际为单片；保留分片以兼容直调）。
  const batches = chunk(urls, BATCH_LIMIT);
  /** @type {any[]} */
  const results = [];
  /** @type {any[]} */
  const errors = [];
  let usage;

  for (const batch of batches) {
    // 上游请求体动态组装（query/chunks/timeout 按需透传），压 any 避免隐式报错。
    const body = /** @type {any} */ ({
      urls: batch,
      extract_depth: extractDepth,
      format,
      include_usage: true,
    });
    if (query !== undefined) body.query = query;
    if (chunksPerSource !== undefined) body.chunks_per_source = chunksPerSource;
    if (timeout !== undefined) body.timeout = timeout;

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
      throw fail(
        'UPSTREAM_UNAVAILABLE',
        'Tavily 抓取请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause),
        { retryable: true },
      );
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
      throw fail('UPSTREAM_RATE_LIMITED', 'Tavily 限流（429）', {
        status: 429,
        retryable: true,
      });
    }
    if (!res.ok) {
      throw fail('UPSTREAM_ERROR', 'Tavily 抓取异常：HTTP ' + res.status, {
        status: res.status,
        retryable: res.status === 408 || res.status >= 500,
      });
    }

    // 上游响应形状动态，压 any 后再取值。
    const data = /** @type {any} */ (await res.json());
    const rawResults = Array.isArray(data && data.results) ? data.results : [];
    const rawFailed = Array.isArray(data && data.failed_results) ? data.failed_results : [];
    if (data && data.usage !== undefined) usage = data.usage;

    for (const /** @type {any} */ item of rawResults) {
      const source = String(item.url || '');
      results.push({
        url: source,
        finalUrl: source,
        title: String(item.title || ''),
        content: String(item.raw_content || item.content || ''),
      });
    }
    for (const /** @type {any} */ item of rawFailed) {
      const source = String(item.url || '');
      const message = String(item.error || 'extract_failed');
      errors.push({ url: source, error: message, retryable: isItemRetryable(message) });
    }
  }

  // 失败分项不带状态码时清理 status 字段，保持形状干净。
  const out = /** @type {any} */ ({ results, errors });
  if (usage !== undefined) out.usage = usage;
  return out;
}
