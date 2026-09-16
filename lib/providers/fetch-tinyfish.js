/**
 * Tinyfish 抓取供应商（批量抓取，统一抓形状适配层）。
 *
 * 上游：POST https://api.fetch.tinyfish.ai，请求头 X-API-Key。
 * 语义：HTTP 200 包内 results[]/errors[] 逐 URL 结算，原样归一为 UnifiedFetch。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认抓取端点（deps.fetchUrlTinyfish 优先）。
const DEFAULT_FETCH_URL = 'https://api.fetch.tinyfish.ai';

/**
 * 恒可重试的包内错误枚举。
 * @type {Set<string>}
 */
const ALWAYS_RETRYABLE = new Set([
  'timeout',
  'bot_blocked',
  'target_unreachable',
]);

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
 * 判定包内单条错误是否可重试。
 * @param {string} error 错误枚举
 * @param {number|undefined} status 伴随 HTTP 状态码
 * @returns {boolean} 是否可重试
 */
function isRetryable(error, status) {
  if (ALWAYS_RETRYABLE.has(error)) return true;
  // 目标站 5xx 视为可重试，其余（404/空内容/登录墙等）不可重试。
  if (error === 'target_http_error' && typeof status === 'number' && status >= 500) {
    return true;
  }
  return false;
}

/**
 * 从 deps 解析 Tinyfish 密钥与抓取地址。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveTinyfish(deps) {
  const apiKey =
    (deps && (deps.tinyfishApiKey || deps.tinyfishKey || deps.TINYFISH_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 TINYFISH_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlTinyfish || deps.tinyfishFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * Tinyfish 批量抓取。
 * @param {{urls: string[], format?: 'markdown'|'html', ttl?: number, perUrlTimeoutMs?: number}} params
 *   统一抓输入（urls 1..10；ttl/perUrlTimeoutMs 透传上游）
 * @param {any} deps 依赖（含 tinyfishApiKey、fetchUrlTinyfish）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string, publishedDate?: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>}>}
 *   归一后的成功与失败列表
 */
export async function tinyfishFetch(params, deps) {
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

  const format = params.format === 'html' ? 'html' : 'markdown';
  const { apiKey, url } = resolveTinyfish(deps);

  // 组装上游请求体：ttl/perUrlTimeoutMs 仅在调用方显式传入时透传。
  // 上游请求体字段动态（ttl 等按需透传），整体压为 any，避免隐式 any 报错。
  const body = /** @type {any} */ ({ urls, format });
  if (params.ttl !== undefined) body.ttl = params.ttl;
  if (params.perUrlTimeoutMs !== undefined) {
    body.per_url_timeout_ms = params.perUrlTimeoutMs;
  }

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw fail(
      'UPSTREAM_UNAVAILABLE',
      'Tinyfish 抓取请求失败：' + String((cause && /** @type {any} */ (cause).message) || cause),
      { retryable: true },
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Tinyfish 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Tinyfish 钱包余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 429) {
    throw fail('UPSTREAM_RATE_LIMITED', 'Tinyfish 限流（429）', {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Tinyfish 抓取异常：HTTP ' + res.status, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 408,
    });
  }

  const data = await res.json();
  const rawResults = Array.isArray(data && data.results) ? data.results : [];
  const rawErrors = Array.isArray(data && data.errors) ? data.errors : [];

  const results = rawResults.map((/** @type {any} */ item) => {
    // 归一输出对象需动态追加 publishedDate，压为 any，避免缺失字段报错。
    const out = /** @type {any} */ ({
      url: String(item.url || ''),
      finalUrl: String(item.final_url || item.finalUrl || item.url || ''),
      title: String(item.title || ''),
      content: String(item.text || item.markdown || item.content || ''),
    });
    const published = item.published_date || item.publishedDate;
    if (typeof published === 'string' && published) out.publishedDate = published;
    return out;
  });

  const errors = rawErrors.map((/** @type {any} */ item) => {
    const code = String(item.error || 'unknown_error');
    const status = typeof item.status === 'number' ? item.status : undefined;
    // 错误条目需动态追加 status，压为 any，避免缺失字段报错。
    const entry = /** @type {any} */ ({
      url: String(item.url || ''),
      error: code,
      retryable: isRetryable(code, status),
    });
    return entry;
  });

  return { results, errors };
}
