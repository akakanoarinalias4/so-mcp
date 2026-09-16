/**
 * Scrape.do 抓取供应商（单请求单 URL，限并发扇出适配批量）。
 *
 * 上游：GET https://api.scrape.do/?token=...&url=...&output=markdown（token 走 query 鉴权，API 模式）。
 * 计费（已核对 pricing 与 request-costs 文档）：
 * - 仅成功请求扣费，成功码为 2XX/400/404/410，其余失败免费；每响应的
 *   Scrape-do-Request-Cost 头为实际扣费权威值（服务端按域强制升档时以该头对账）。
 * - 基础档：数据中心 1 点，数据中心+渲染 5 点，住宅 super 10 点，住宅+渲染 25 点；
 *   google.* 等域服务端默认 super（10 点），realestate.com.au/aircanada.com 等默认 super+渲染。
 * 并发：免费每月 1000 次成功请求、5 并发；网关单批最多 10 条，本适配限并发 5 扇出再合并。
 * 输出：output=markdown；响应体超限截断（普通 4MB，super 代理 2MB，服务端强制升档时以响应头对账）。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认抓取端点（deps.fetchUrlScrapedo 优先）。
const DEFAULT_FETCH_URL = 'https://api.scrape.do/';

// 免费档并发上限：扇出工作协程数（可用 deps.scrapedoConcurrency 覆盖，上限钳制在 1..5）。
const DEFAULT_CONCURRENCY = 5;

// 普通代理响应体上限 4MB（与网关 MAX_REQUEST_BYTES 对齐）。
const MAX_BYTES = 4 * 1024 * 1024;

// super 住宅代理响应体上限 2MB。
const SUPER_MAX_BYTES = 2 * 1024 * 1024;

// 服务端默认加 super 的域名（住宅代理自动应用，10 点；客户端显式透传可保持一致）。
const SUPER_DOMAINS = [
  'idealista.',
  'akakce.com',
  'capterra.com',
  'hermes.com',
  'leboncoin.fr',
  'mouser.com',
];

// 服务端默认加渲染的域名（按文档的 per-domain 定价表）。
const RENDER_DOMAINS = ['therealreal.com', 'realestate.com.au', 'aircanada.com'];

// 服务端默认 super+渲染的域名。
const SUPER_RENDER_DOMAINS = ['realestate.com.au', 'aircanada.com'];

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
 * 从 deps 解析 Scrape.do 密钥与抓取地址。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveScrapedo(deps) {
  const apiKey =
    (deps &&
      (deps.scrapedoApiKey ||
        deps.scrapedoKey ||
        deps.scrapeDoApiKey ||
        deps.SCRAPEDO_API_KEY ||
        deps.SCRAPE_DO_API_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 SCRAPEDO_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlScrapedo || deps.scrapedoFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 按目标域名推导服务端强制档位（google.* 等默认 super，硬目标才开 super/render）。
 * @param {string} host 目标小写域名
 * @returns {{super: boolean, render: boolean}} 自动档位
 */
function autoProfile(host) {
  const name = String(host || '').toLowerCase();
  // google.* 全系后缀默认住宅代理。
  if (/(^|\.)google\./.test(name)) return { super: true, render: false };
  if (SUPER_RENDER_DOMAINS.some((d) => name === d || name.endsWith('.' + d))) {
    return { super: true, render: true };
  }
  if (RENDER_DOMAINS.some((d) => name === d || name.endsWith('.' + d))) {
    return { super: false, render: true };
  }
  if (SUPER_DOMAINS.some((d) => name === d || name.endsWith('.' + d))) {
    return { super: true, render: false };
  }
  return { super: false, render: false };
}

/**
 * 解析单条目标的 super/render 开关：显式参数优先，其次自动档位，默认最低成本。
 * @param {any} params 统一抓输入（可附带 super/render 显式开关）
 * @param {any} deps 依赖（可附带 scrapedoSuper/scrapedoRender 全局开关）
 * @param {string} target 目标 URL
 * @returns {{super: boolean, render: boolean}} 生效档位
 */
function resolveProfile(params, deps, target) {
  let host = '';
  try {
    host = new URL(String(target)).hostname;
  } catch {
    host = '';
  }
  const auto = autoProfile(host);
  const explicitSuper =
    (params && params.super) ?? (deps && deps.scrapedoSuper) ?? undefined;
  const explicitRender =
    (params && params.render) ?? (deps && deps.scrapedoRender) ?? undefined;
  return {
    super: explicitSuper ?? auto.super ?? false,
    render: explicitRender ?? auto.render ?? false,
  };
}

/**
 * 兼容 Headers 实例与普通对象读取响应头。
 * @param {any} res 抓取响应
 * @param {string} name 头名
 * @returns {string} 头值（缺失为空串）
 */
function headerValue(res, name) {
  try {
    const headers = res && res.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') {
      return String(headers.get(name) || headers.get(name.toLowerCase()) || '');
    }
    const lower = String(name).toLowerCase();
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === lower) return String(headers[key]);
    }
  } catch {
    return '';
  }
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
 * 从 markdown/HTML 文本中提取标题（HTML 取 <title>，缺失为空串）。
 * @param {string} text 响应正文
 * @returns {string} 标题
 */
function extractTitle(text) {
  if (typeof text !== 'string' || !text) return '';
  const matched = /<title[^>]*>([\s\S]{1,500})<\/title>/i.exec(text);
  if (!matched) return '';
  return String(matched[1]).replace(/\s+/g, ' ').trim();
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {string} apiKey Scrape.do 密钥
 * @param {string} endpoint 抓取端点
 * @param {{format: string, perUrlTimeoutMs?: number, super?: boolean, render?: boolean}} options 单条选项
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<{url: string, finalUrl: string, title: string, content: string}>} 归一成功项
 */
async function fetchSingle(target, apiKey, endpoint, options, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  const profile = { super: !!options.super, render: !!options.render };
  // 组装上游查询串：token 鉴权 + 目标地址 + markdown 输出；硬目标才带 super/render。
  const query = new URLSearchParams();
  query.set('token', apiKey);
  query.set('url', String(target));
  query.set('output', options.format === 'html' ? 'raw' : 'markdown');
  if (profile.super) query.set('super', 'true');
  if (profile.render) query.set('render', 'true');
  const timeoutMs = Number(options.perUrlTimeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    query.set('timeout', String(Math.max(1000, Math.min(120000, Math.floor(timeoutMs)))));
  }
  const separator = endpoint.includes('?') ? '&' : '?';
  const requestUrl = endpoint + separator + query.toString();
  // perUrlTimeoutMs 同时作为客户端中止时限，超时错误可重试。
  const signal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.floor(timeoutMs))
      : undefined;

  /** @type {Response} */
  let res;
  try {
    res = await impl(requestUrl, { method: 'GET', headers: { Accept: '*/*' }, signal });
  } catch (cause) {
    throw fail('UPSTREAM_UNAVAILABLE', 'Scrape.do 抓取请求失败：' + String(target), {
      retryable: true,
    });
  }

  // 最终地址：服务端解析后的落地页优先，否则回落目标地址。
  const finalUrl =
    headerValue(res, 'Scrape-do-Resolved-Url') ||
    headerValue(res, 'Scrape-do-Target-Url') ||
    String(target);

  if (res.ok) {
    const text = await res.text();
    // 截断上限以响应头实际扣费对账：super 档（含服务端强制升档）2MB，否则 4MB。
    const billed = Number.parseInt(headerValue(res, 'Scrape-do-Request-Cost'), 10);
    const limit =
      profile.super || (Number.isFinite(billed) && billed >= 10)
        ? SUPER_MAX_BYTES
        : MAX_BYTES;
    const content = truncateUtf8(String(text || ''), limit);
    return { url: String(target), finalUrl, title: extractTitle(content), content };
  }

  // 401/403 密钥无效不可重试，402 余额不足不可重试。
  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Scrape.do 密钥无效或无权限', {
      status: res.status,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Scrape.do 余额不足', {
      status: res.status,
      retryable: false,
    });
  }
  // 400/404/410 已扣费（成功计费码），记为不可重试失败，避免回退重复扣费。
  if (res.status === 400 || res.status === 404 || res.status === 410) {
    throw fail(res.status === 400 ? 'target_http_error' : 'page_not_found', 'Scrape.do 目标异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: false,
    });
  }
  // 429/408/5xx 可重试。
  if (res.status === 429 || res.status === 408 || res.status >= 500) {
    throw fail(
      res.status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_ERROR',
      'Scrape.do 抓取异常：' + target + ' HTTP ' + res.status,
      { status: res.status, retryable: true },
    );
  }
  throw fail('UPSTREAM_ERROR', 'Scrape.do 抓取异常：' + target + ' HTTP ' + res.status, {
    status: res.status,
    retryable: false,
  });
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
 * Scrape.do 批量抓取（单请求单 URL，限并发扇出再合并）。
 * @param {{urls: string[], format?: 'markdown'|'html', ttl?: number, perUrlTimeoutMs?: number, super?: boolean, render?: boolean}} params
 *   统一抓输入（urls 1..10；format 映射 output；super/render 仅硬目标开启）
 * @param {any} deps 依赖（含 scrapedoApiKey、fetchUrlScrapedo、scrapedoConcurrency）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>}>}
 *   归一后的成功与失败列表
 */
export async function scrapedoFetch(params, deps) {
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
  const { apiKey, url } = resolveScrapedo(deps);
  // 并发钳制在免费档 5 以内，付费提额可由 deps.scrapedoConcurrency 覆盖（仍钳制防打爆）。
  const rawLimit = Number(deps && deps.scrapedoConcurrency);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(5, Math.floor(rawLimit)))
    : DEFAULT_CONCURRENCY;

  const targets = urls.map((u) => String(u));
  const settled = await mapLimit(targets, limit, (target) => {
    const profile = resolveProfile(params, deps, target);
    return fetchSingle(
      target,
      apiKey,
      url,
      { format, perUrlTimeoutMs: params.perUrlTimeoutMs, super: profile.super, render: profile.render },
      fetchImpl,
    );
  });

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
