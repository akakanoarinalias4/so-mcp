/**
 * ScraperAPI 抓取供应商（单条 GET 扇出适配批量，统一抓取形状适配层）。
 *
 * 上游：GET http://api.scraperapi.com，查询参数 api_key/url/render/premium/
 * ultra_premium/country_code/max_cost/output_format（overrides 见 deps）。
 * 单条扇出：上游一次只抓一条 URL，网关 1..10 条用 Promise.all 扇出合并。
 *
 * 难度加权（按官方 credits-and-requests-costs 文档）：
 * - 标准域名 1 点；电商（Amazon/Walmart/eBay）5 点；
 *   SERP（Google/Bing 全子域）25 点；社交（LinkedIn）30 点。
 * - 反爬 bypass（Cloudflare/Turnstile/Datadome/PerimeterX）另加 10 点，
 *   事前无法探测，只能按 ultra_premium 是否开启估算，实际以 sa-credit-cost 为准。
 * - 参数附加：premium 10 点；render 10 点；ultra_premium 30 点；
 *   premium+render 25 点；ultra_premium+render 75 点。
 * - 不加价：output_format/country_code/session_number/device_type/
 *   keep_headers/autoparse/wait_for_selector。
 * - 估算取上界（域名价 + 参数附加），用于 max_cost 熔断预检，宁可早熔断也不超支。
 *
 * 熔断与失败计费：
 * - max_cost：服务端预算上限，超限回 403（正文含 max_cost），直接不可重试，
 *   本地先按估算预检，超限不发网直接记 errors（status 403，retryable false）。
 * - 仅 200 与 404 计费；70 秒重试后仍失败的 500 不计费；调用方提前取消的不计费。
 * - 404 是目标页不存在（仍计费），不可重试；429 是并发超限，可重试；
 *   403 无剩余额度（低档耗尽需升级套餐或开 overages），不可重试；
 *   401 是密钥无效，不可重试；408/5xx 可重试。
 * - 成功响应头 sa-credit-cost 为单次实际扣费，累加进 usage.billedCredits。
 *
 * 零运行时依赖，原生 ESM，仅用全局 fetch；不打日志，不打印密钥。
 */

// 默认抓取端点（deps.fetchUrlScraperapi / deps.scraperapiFetchUrl 优先）。
const DEFAULT_FETCH_URL = 'http://api.scraperapi.com';

// 网关单批上限（与 tools.js 校验对齐，超出直接 INVALID_PARAMS）。
const MAX_URLS = 10;

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
 * 从 deps 解析 ScraperAPI 密钥与抓取地址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveScraperapi(deps) {
  const apiKey =
    (deps &&
      (deps.scraperapiApiKey ||
        deps.scraperApiKey ||
        deps.scraperapiKey ||
        deps.SCRAPERAPI_API_KEY ||
        deps.SCRAPER_API_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 SCRAPERAPI_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlScraperapi || deps.scraperapiFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 解析布尔开关（true/'true' 为开，其余为关）。
 * @param {any} value 原始值
 * @returns {boolean} 是否开启
 */
function toBool(value) {
  return value === true || value === 'true';
}

/**
 * 按主机名判定域名难度价。
 * @param {string} target 目标 URL
 * @returns {number} 域名基础价（1/5/25/30）
 */
function domainCost(target) {
  // 主机解析失败时按标准价兜底，不阻断抓取。
  let host = '';
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch (_ignored) {
    return 1;
  }
  // 电商定制逻辑：Amazon/Walmart/eBay。
  if (
    /(^|\.)amazon\./.test(host) ||
    /(^|\.)walmart\./.test(host) ||
    /(^|\.)ebay\./.test(host)
  ) {
    return 5;
  }
  // SERP 定制逻辑：Google/Bing 全子域。
  if (/(^|\.)google\./.test(host) || /(^|\.)bing\./.test(host)) {
    return 25;
  }
  // 社交定制逻辑：LinkedIn。
  if (/(^|\.)linkedin\./.test(host)) {
    return 30;
  }
  return 1;
}

/**
 * 估算参数附加费（组合价优先于单项相加）。
 * @param {{render: boolean, premium: boolean, ultraPremium: boolean, screenshot: boolean}} opts 渲染与代理开关
 * @returns {number} 参数附加点数
 */
function paramExtra(opts) {
  if (opts.ultraPremium && opts.render) return 75;
  if (opts.premium && opts.render) return 25;
  if (opts.ultraPremium) return 30;
  if (opts.premium) return 10;
  // screenshot 会自动开启渲染，同 render 计 10 点。
  if (opts.render || opts.screenshot) return 10;
  return 0;
}

/**
 * 估算单次抓取点数（上界：域名价 + 参数附加；反爬 +10 风险已隐含在 premium/ultra 档中）。
 * @param {string} target 目标 URL
 * @param {{render: boolean, premium: boolean, ultraPremium: boolean, screenshot: boolean}} opts 渲染与代理开关
 * @returns {number} 预估点数
 */
function estimateCost(target, opts) {
  return domainCost(target) + paramExtra(opts);
}

/**
 * 从 HTML 标题标签提取标题（无标题返回空串）。
 * @param {string} html 响应正文
 * @returns {string} 标题
 */
function parseTitle(html) {
  if (typeof html !== 'string' || !html) return '';
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}

/**
 * 组装 ScraperAPI 请求地址（密钥只进查询串，不进日志）。
 * @param {string} endpoint 抓取端点
 * @param {string} apiKey 密钥
 * @param {string} target 目标 URL
 * @param {{render: boolean, premium: boolean, ultraPremium: boolean, countryCode?: string, outputFormat?: string, maxCost?: number}} opts 上游开关
 * @returns {string} 完整 GET 地址
 */
function buildRequestUrl(endpoint, apiKey, target, opts) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const parts = [
    'api_key=' + encodeURIComponent(apiKey),
    'url=' + encodeURIComponent(target),
  ];
  if (opts.render) parts.push('render=true');
  if (opts.premium) parts.push('premium=true');
  if (opts.ultraPremium) parts.push('ultra_premium=true');
  if (opts.countryCode) parts.push('country_code=' + encodeURIComponent(opts.countryCode));
  // output_format 不加价：markdown/text 按映射透传，html 走默认原文。
  if (opts.outputFormat) parts.push('output_format=' + encodeURIComponent(opts.outputFormat));
  if (opts.maxCost !== undefined) parts.push('max_cost=' + encodeURIComponent(String(opts.maxCost)));
  return endpoint + sep + parts.join('&');
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {{render: boolean, premium: boolean, ultraPremium: boolean, countryCode?: string, outputFormat?: string, maxCost?: number, perUrlTimeoutMs?: number}} opts 上游开关与超时
 * @param {string} apiKey 密钥
 * @param {string} endpoint 抓取端点
 * @param {(url: string, init?: any) => Promise<Response>} fetchImpl 抓取实现
 * @returns {Promise<{item: {url: string, finalUrl: string, title: string, content: string}, cost: number, billed?: number}>} 归一成功项与费用
 */
async function fetchSingle(target, opts, apiKey, endpoint, fetchImpl) {
  // 本地熔断预检：估算超 max_cost 直接记 403，不发网省点数。
  const cost = estimateCost(target, opts);
  if (opts.maxCost !== undefined && cost > opts.maxCost) {
    throw fail('MAX_COST_EXCEEDED', 'ScraperAPI 熔断：预估 ' + cost + ' 点超 max_cost ' + opts.maxCost, {
      status: 403,
      retryable: false,
    });
  }

  const requestUrl = buildRequestUrl(endpoint, apiKey, target, opts);
  // 单 URL 超时：AbortSignal.timeout 可用则用，否则不设超时（上游默认重试 70 秒）。
  /** @type {any} */
  let signal;
  if (
    opts.perUrlTimeoutMs !== undefined &&
    Number.isFinite(opts.perUrlTimeoutMs) &&
    opts.perUrlTimeoutMs > 0
  ) {
    try {
      signal = AbortSignal.timeout(Math.floor(opts.perUrlTimeoutMs));
    } catch (_ignored) {
      signal = undefined;
    }
  }

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(requestUrl, signal === undefined ? { method: 'GET' } : { method: 'GET', signal });
  } catch (cause) {
    // 超时/断网一律可重试（500 级重试语义，不计费）。
    const causeAny = /** @type {any} */ (cause);
    const aborted =
      causeAny && (causeAny.name === 'TimeoutError' || causeAny.name === 'AbortError');
    throw fail(aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', 'ScraperAPI 抓取请求失败：' + target, {
      retryable: true,
    });
  }

  // 响应头实际扣费（仅成功/404 有值），透出给 usage 累加。
  let billed;
  try {
    const raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('sa-credit-cost') : null;
    const n = raw === null || raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(n)) billed = n;
  } catch (_ignored) {
    billed = undefined;
  }

  if (res.status === 200) {
    const text = await res.text();
    const out = {
      url: target,
      // follow_redirect 默认 true，上游不回传终址，用目标地址兜底。
      finalUrl: target,
      title: parseTitle(text),
      content: typeof text === 'string' ? text : String(text || ''),
    };
    const done = /** @type {any} */ ({ item: out, cost });
    if (billed !== undefined) done.billed = billed;
    return done;
  }
  if (res.status === 404) {
    // 目标页不存在：仍计费，不可重试（止损）。
    throw fail('page_not_found', 'ScraperAPI 目标页不存在：' + target, {
      status: 404,
      retryable: false,
    });
  }
  if (res.status === 402) {
    // 部分网关透出 402 余额不足：与 403 耗尽同语义，均不可重试。
    throw fail('INSUFFICIENT_CREDIT', 'ScraperAPI 剩余额度不足（402），需升级套餐或开启 overages', {
      status: 402,
      retryable: false,
    });
  }
  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'ScraperAPI 密钥无效或无权限', {
      status: 401,
      retryable: false,
    });
  }
  if (res.status === 403) {
    // 403 双因：max_cost 超限 vs 剩余额度耗尽，均不可重试；读正文区分提示。
    let body = '';
    try {
      body = await res.text();
    } catch (_ignored) {
      body = '';
    }
    const isMaxCost = typeof body === 'string' && body.toLowerCase().includes('max_cost');
    throw fail(
      isMaxCost ? 'MAX_COST_EXCEEDED' : 'INSUFFICIENT_CREDIT',
      isMaxCost
        ? 'ScraperAPI 熔断：请求超 max_cost 上限'
        : 'ScraperAPI 剩余额度耗尽，需升级套餐或开启 overages',
      { status: 403, retryable: false },
    );
  }
  if (res.status === 429) {
    // 并发超限：按套餐并发线程数降并发后可重试。
    throw fail('UPSTREAM_RATE_LIMITED', 'ScraperAPI 并发超限（429）：' + target, {
      status: 429,
      retryable: true,
    });
  }
  if (res.status === 400) {
    throw fail('INVALID_REQUEST', 'ScraperAPI 非法请求（400）：' + target, {
      status: 400,
      retryable: false,
    });
  }
  throw fail('UPSTREAM_ERROR', 'ScraperAPI 抓取异常：' + target + ' HTTP ' + res.status, {
    status: res.status,
    retryable: res.status === 408 || res.status >= 500,
  });
}

/**
 * ScraperAPI 批量抓取（单条 GET 扇出合并）。
 * @param {{urls: string[], format?: string, render?: boolean, premium?: boolean, ultra_premium?: boolean, ultraPremium?: boolean, country_code?: string, countryCode?: string, max_cost?: number, maxCost?: number, output_format?: string, outputFormat?: string, perUrlTimeoutMs?: number}} params
 *   统一抓取输入（urls 1..10；format 映射 output_format；render/premium/ultra 为成本档；
 *   country_code 地理定向不加价；max_cost 熔断上限；perUrlTimeoutMs 单条超时毫秒）
 * @param {any} deps 依赖（含 scraperapiApiKey、fetchUrlScraperapi、fetchImpl）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>, usage?: any}>}
 *   归一后的成功与失败列表（usage 含预估与实扣点数）
 */
export async function scraperapiFetch(params, deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const urls = params && params.urls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_URLS) {
    throw fail('INVALID_PARAMS', 'urls 必须为 1..10 个 URL 的数组');
  }
  for (const u of urls) {
    if (typeof u !== 'string' || !(u.startsWith('http://') || u.startsWith('https://'))) {
      throw fail('INVALID_PARAMS', 'urls 仅支持 http/https 字符串：' + String(u));
    }
  }
  // 缺键直接抛码，不触碰网络。
  const { apiKey, url } = resolveScraperapi(deps);

  // 档位归一：ultra 与 premium 互斥，ultra 优先（按官方不可组合规则）。
  const render = toBool(params.render);
  const ultraPremium = toBool(params.ultra_premium ?? params.ultraPremium);
  const premium = ultraPremium ? false : toBool(params.premium);
  const screenshot = toBool(params.screenshot);
  // 地理定向：非空字符串透传，不加价。
  const countryRaw = params.country_code ?? params.countryCode;
  const countryCode =
    typeof countryRaw === 'string' && countryRaw.trim() ? countryRaw.trim().toLowerCase() : undefined;
  // 输出形态：markdown/text 透传不加价；html/缺省走原文（不带 output_format）。
  let outputFormat = params.output_format ?? params.outputFormat;
  if (outputFormat === undefined && typeof params.format === 'string') {
    if (params.format === 'markdown') outputFormat = 'markdown';
    else if (params.format === 'text') outputFormat = 'text';
    else outputFormat = undefined;
  }
  if (outputFormat !== 'markdown' && outputFormat !== 'text') outputFormat = undefined;
  // 熔断上限：正整数才透传。
  let maxCost;
  const maxRaw = params.max_cost ?? params.maxCost;
  if (maxRaw !== undefined) {
    const n = Number(maxRaw);
    if (Number.isFinite(n) && n > 0) maxCost = Math.floor(n);
  }
  // 单条超时：正整数毫秒才透传给 AbortSignal。
  let perUrlTimeoutMs;
  if (params.perUrlTimeoutMs !== undefined) {
    const n = Number(params.perUrlTimeoutMs);
    if (Number.isFinite(n) && n > 0) perUrlTimeoutMs = Math.floor(n);
  }
  const opts = { render, premium, ultraPremium, countryCode, outputFormat, maxCost, perUrlTimeoutMs };

  // 单批扇出：逐 URL 结算，成功进 results，失败进 errors，费用累加进 usage。
  const settled = /** @type {any[]} */ (
    await Promise.all(
      urls.map(async (/** @type {any} */ target) => {
        try {
          const done = await fetchSingle(String(target), opts, apiKey, url, fetchImpl);
          return { ok: true, value: done };
        } catch (err) {
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
    )
  );

  const results = /** @type {any[]} */ ([]);
  const errors = /** @type {any[]} */ ([]);
  let estimatedCredits = 0;
  let billedCredits = 0;
  let hasBilled = false;
  for (const entry of settled) {
    if (entry.ok) {
      results.push(entry.value.item);
      estimatedCredits += entry.value.cost || 0;
      if (typeof entry.value.billed === 'number') {
        billedCredits += entry.value.billed;
        hasBilled = true;
      }
    } else {
      errors.push(
        (() => {
          // 清理 undefined 状态码，保持 errors[] 形状干净。
          const e = /** @type {any} */ ({
            url: entry.value.url,
            error: entry.value.error,
            retryable: entry.value.retryable,
          });
          if (entry.value.status !== undefined) e.status = entry.value.status;
          return e;
        })(),
      );
    }
  }
  // usage 透出难度加权预估与实扣（实扣仅成功项有响应头时累加）。
  const usage = /** @type {any} */ ({ provider: 'scraperapi', estimatedCredits });
  if (hasBilled) usage.billedCredits = billedCredits;
  return { results, errors, usage };
}
