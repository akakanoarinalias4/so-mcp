/**
 * Linkup 抓取供应商（回退抓取：单条扇出适配批量）。
 *
 * 上游：POST https://api.linkup.so/v1/fetch，Bearer 鉴权，单次仅支持一条 URL。
 * 策略：mode 固定 standard 且不渲染；空内容不自动升级（升级由调用方决定）。
 * 异常统一映射为 errors[]，与 Tinyfish 归一形状对齐，便于调用方做回退结算。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认抓取端点（deps.fetchUrlLinkup 优先）。
const DEFAULT_FETCH_URL = 'https://api.linkup.so/v1/fetch';

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
 * 从 deps 解析 Linkup 密钥与抓取地址。
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
    (deps && (deps.fetchUrlLinkup || deps.linkupFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {string} apiKey Linkup 密钥
 * @param {string} endpoint 抓取端点
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<{url: string, finalUrl: string, title: string, content: string}>} 归一成功项
 */
async function fetchSingle(target, apiKey, endpoint, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  /** @type {Response} */
  let res;
  try {
    res = await impl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      // 回退抓取固定 standard 无渲染，不自动升级到 pro/renderJs。
      body: JSON.stringify({ url: target, mode: 'standard' }),
    });
  } catch (cause) {
    throw fail('UPSTREAM_UNAVAILABLE', 'Linkup 抓取请求失败：' + String(target), {
      retryable: true,
    });
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    const code =
      res.status === 429
        ? 'UPSTREAM_RATE_LIMITED'
        : res.status === 404
          ? 'page_not_found'
          : 'target_http_error';
    throw fail(code, 'Linkup 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable,
    });
  }

  // 上游抓取响应形状动态，压为 any 后再取值，避免隐式 any 报错。
  const data = /** @type {any} */ (await res.json());
  return {
    url: target,
    finalUrl: String((data && (data.finalUrl || data.url)) || target),
    title: String((data && (data.title || data.name)) || ''),
    content: String((data && (data.markdown || data.content || data.text)) || ''),
  };
}

/**
 * Linkup 批量抓取（单条扇出适配）。
 * @param {{urls: string[], format?: 'markdown'|'html'}} params 统一抓输入（format 仅透传语义，Linkup 恒返 markdown）
 * @param {any} deps 依赖（含 linkupApiKey、fetchUrlLinkup）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>}>}
 *   归一后的成功与失败列表
 */
export async function linkupFetch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const urls = params && params.urls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 10) {
    throw fail('INVALID_PARAMS', 'urls 必须为 1..10 个 URL 的数组');
  }
  const { apiKey, url } = resolveLinkup(deps);

  // 扇出结果为成功/失败联合形状，压为 any[]，避免联合取值报错。
  const settled = /** @type {any[]} */ (await Promise.all(
    urls.map(async (/** @type {any} */ target) => {
      try {
        const ok = await fetchSingle(String(target), apiKey, url, fetchImpl);
        return { ok: true, value: ok };
      } catch (err) {
        // 捕获异常为未知形状，转 any 后再取 code/status/retryable。
        const caught = /** @type {any} */ (err);
        return {
          ok: false,
          value: {
            url: String(target),
            error: String((caught && caught.code) || 'target_unreachable'),
            status: caught && caught.status !== undefined ? caught.status : undefined,
            retryable: caught && caught.retryable !== undefined ? !!caught.retryable : false,
          },
        };
      }
    }),
  ));

  // 成功与失败列表元素形状不同，压为 any[]，避免联合赋值报错。
  const results = /** @type {any[]} */ ([]);
  const errors = /** @type {any[]} */ ([]);
  for (const item of settled) {
    if (item.ok) {
      results.push(item.value);
    } else {
      // 清理 undefined 状态码，保持 errors[] 形状干净。
      const entry = /** @type {any} */ ({ url: item.value.url, error: item.value.error, retryable: item.value.retryable });
      if (item.value.status !== undefined) entry.status = item.value.status;
      errors.push(entry);
    }
  }
  return { results, errors };
}
