/**
 * HasData 通用抓取供应商（单请求单 URL，限并发扇出适配批量）。
 *
 * 上游：POST https://api.hasdata.com/scrape/web，请求头 x-api-key。
 * 计费（已核对 request-cost 与 credits-and-concurrency 文档）：
 * - 仅成功请求扣费，失败不计费可重试；成功定义为 HTTP 200 且包内 status:"ok"。
 * - 费用矩阵由 jsRendering × proxyType 决定：非渲染+数据中心 1 点，
 *   非渲染+住宅 5 点，渲染+数据中心 10 点，渲染+住宅 15 点。
 * - 默认非渲染数据中心 1 点最低成本；免费每月 1000 点、1 并发。
 * 输出：outputFormat 支持 html/text/markdown/json，本适配按统一 format 映射
 *   markdown->["markdown"]、html->["html"]，缺省 markdown。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认抓取端点（deps.fetchUrlHasdata 优先）。
const DEFAULT_FETCH_URL = 'https://api.hasdata.com/scrape/web';

// 默认扇出并发：免费档仅 1 并发，取 3 兼顾速度与 429 风险，可由 deps.hasdataConcurrency 覆盖。
const DEFAULT_CONCURRENCY = 3;

// UTF-8 编解码器（字节级截断用，避免多字节字符被拦腰截断）。
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
 * 从 deps 解析 HasData 密钥与抓取地址。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveHasdata(deps) {
  const apiKey =
    (deps && (deps.hasdataApiKey || deps.hasdataKey || deps.HASDATA_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 HASDATA_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlHasdata || deps.hasdataFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 按统一 format 映射 HasData 输出格式（支持 html/text/markdown/json）。
 * @param {any} format 统一抓输入的 format
 * @returns {string[]} HasData outputFormat 数组
 */
function resolveOutputFormat(format) {
  if (format === 'html') return ['html'];
  if (format === 'text') return ['text'];
  if (format === 'json') return ['json'];
  return ['markdown'];
}

/**
 * 从抓取正文中提取标题（HTML 取 <title>，markdown 取首个 # 标题，缺失为空串）。
 * @param {string} text 响应正文
 * @returns {string} 标题
 */
function extractTitle(text) {
  if (typeof text !== 'string' || !text) return '';
  const htmlTitle = /<title[^>]*>([\s\S]{1,500})<\/title>/i.exec(text);
  if (htmlTitle) return String(htmlTitle[1]).replace(/\s+/g, ' ').trim();
  const mdTitle = /^#{1,6}\s+(.+)$/m.exec(text);
  if (mdTitle) return String(mdTitle[1]).replace(/\s+/g, ' ').trim().slice(0, 200);
  return '';
}

/**
 * 按字节上限截断字符串（UTF-8 安全）。
 * @param {string} text 原文
 * @param {number} limit 字节上限
 * @returns {string} 截断后文本
 */
function truncateUtf8(text, limit) {
  const bytes = textEncoder.encode(text);
  if (bytes.length <= limit) return text;
  return textDecoder.decode(bytes.slice(0, limit));
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {string} apiKey HasData 密钥
 * @param {string} endpoint 抓取端点
 * @param {{outputFormat: string[], perUrlTimeoutMs?: number}} options 单条选项
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<{url: string, finalUrl: string, title: string, content: string}>} 归一成功项
 */
async function fetchSingle(target, apiKey, endpoint, options, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  // 默认非渲染数据中心 1 点最低成本：不主动传 jsRendering/proxyType。
  const body = { url: String(target), outputFormat: options.outputFormat };
  const timeoutMs = Number(options.perUrlTimeoutMs);
  const signal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.floor(timeoutMs))
      : undefined;

  /** @type {Response} */
  let res;
  try {
    res = await impl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw fail('UPSTREAM_UNAVAILABLE', 'HasData 抓取请求失败：' + String(target), {
      retryable: true,
    });
  }

  // 401 密钥无效不可重试；403 为额度耗尽（余额不足）不可重试；402 同理。
  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'HasData 密钥无效', {
      status: 401,
      retryable: false,
    });
  }
  if (res.status === 402 || res.status === 403) {
    throw fail('INSUFFICIENT_CREDIT', 'HasData 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  // 429 并发超限、408 超时、5xx 服务端异常可重试；400 目标失败免费可重试；422 参数错误不可重试。
  if (res.status === 429) {
    throw fail('UPSTREAM_RATE_LIMITED', 'HasData 限流（429）：' + String(target), {
      status: 429,
      retryable: true,
    });
  }
  if (res.status === 400 || res.status === 408 || res.status >= 500) {
    throw fail('UPSTREAM_ERROR', 'HasData 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: true,
    });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'HasData 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: false,
    });
  }

  // 上游响应形状动态，压为 any 后再取值，避免隐式 any 报错。
  const data = /** @type {any} */ (await res.json());
  const meta = (data && data.requestMetadata) || {};
  // 包内 status 非 ok 视为失败：失败不计费，可重试（由调用方回退结算）。
  if (meta && meta.status && meta.status !== 'ok') {
    throw fail('UPSTREAM_ERROR', 'HasData 抓取失败：' + String(target), {
      retryable: true,
    });
  }
  // 目标站声明条目不存在（包内 error + 无数据体）：视为不可重试的 page_not_found。
  const hasPayload =
    (data && (data.markdown || data.content || data.text || data.html || data.json)) !== undefined &&
    (data && (data.markdown || data.content || data.text || data.html || data.json)) !== null &&
    String((data && (data.markdown || data.content || data.text || data.html || data.json)) ?? '') !== '';
  if (data && data.error && !hasPayload) {
    throw fail('page_not_found', 'HasData 目标不存在：' + String(target), {
      retryable: false,
    });
  }
  // 按请求格式优先级取正文：markdown > text > content/html > json。
  const raw =
    (data && (data.markdown || data.text || data.content || data.html)) ??
    (data && data.json !== undefined ? JSON.stringify(data.json) : '');
  const content = truncateUtf8(String(raw || ''), 4 * 1024 * 1024);
  // 归一输出对象需动态追加 publishedDate，压为 any，避免缺失字段报错。
  const out = /** @type {any} */ ({
    url: String(target),
    finalUrl: String((data && (data.finalUrl || data.url)) || target),
    title: extractTitle(content),
    content,
  });
  const published =
    data && (data.publishedDate || data.published_date || data.datePublished);
  if (typeof published === 'string' && published) out.publishedDate = published;
  return out;
}

/**
 * 限并发扇出（保持输入顺序结算）。
 * @param {Array<string>} items 目标列表
 * @param {number} limit 并发上限
 * @param {(target: string, index: number) => Promise<any>} worker 单条工作函数
 * @returns {Promise<Array<{ok: boolean, value?: any, error?: any}>>} 按输入顺序的结算数组
 */
async function mapLimit(items, limit, worker) {
  const settled = new Array(items.length);
  let next = 0;
  const count = Math.max(1, Math.min(limit, items.length));
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        settled[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        settled[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: count }, run));
  return settled;
}

/**
 * HasData 批量抓取（单请求单 URL，限并发扇出再合并，逐 URL 结算）。
 * @param {{urls: string[], format?: 'markdown'|'html'|'text'|'json', ttl?: number, perUrlTimeoutMs?: number}} params
 *   统一抓输入（urls 1..10；format 映射 outputFormat；ttl 忽略）
 * @param {any} deps 依赖（含 hasdataApiKey、fetchUrlHasdata、hasdataConcurrency）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string, publishedDate?: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>}>}
 *   归一后的成功与失败列表
 */
export async function hasdataFetch(params, deps) {
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

  const outputFormat = resolveOutputFormat(params.format);
  const { apiKey, url } = resolveHasdata(deps);
  const rawLimit = Number(deps && deps.hasdataConcurrency);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(5, Math.floor(rawLimit)))
    : DEFAULT_CONCURRENCY;

  const targets = urls.map((u) => String(u));
  const settled = await mapLimit(targets, limit, (target) =>
    fetchSingle(
      target,
      apiKey,
      url,
      { outputFormat, perUrlTimeoutMs: params.perUrlTimeoutMs },
      fetchImpl,
    ),
  );

  // 成功与失败列表元素形状不同，压为 any[]，避免联合赋值报错。
  const results = /** @type {any[]} */ ([]);
  const errors = /** @type {any[]} */ ([]);
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    if (item.ok) {
      results.push(item.value);
    } else {
      // 捕获异常为未知形状，转 any 后再取 code/status/retryable；未知异常默认可重试以便走回退。
      const caught = /** @type {any} */ (item.error);
      // 错误条目需动态追加 status，压为 any，避免缺失字段报错。
      const entry = /** @type {any} */ ({
        url: targets[i],
        error: String((caught && caught.code) || 'target_unreachable'),
        retryable: caught && caught.retryable !== undefined ? !!caught.retryable : true,
      });
      if (caught && caught.status !== undefined) entry.status = caught.status;
      errors.push(entry);
    }
  }
  return { results, errors };
}
