/**
 * Firecrawl 抓取供应商（单页 POST 扇出适配批量，统一抓取形状适配层）。
 *
 * 上游：POST https://api.firecrawl.dev/v2/scrape，请求头 Authorization: Bearer。
 * 单批扇出：上游一次只抓一条 URL，网关 1..10 条用 Promise.all 扇出合并。
 *
 * 计费（按官方 pricing / scrape 文档）：
 * - 单页 scrape 基础 1 点；附加 JSON / query 问答 / highlights /
 *   提示注入检查 / PII 脱敏 / 音视频抽取各加 4 点（按页叠加）；
 *   PDF 解析按 PDF 页数计 1 点/页。
 * - 无结果不计费（success:false 或空 data）；但目标站回 403/404 且有文档
 *   仍返回 success:true + data 并计 1 点，本适配读 data.metadata.statusCode
 *   止损：403/404 归 errors 且不可重试，避免调用方反复重试烧点。
 * - 整站深耕备注（本文件只做单页 scrape，不发起）：
 *   crawl 按页计费（每页 1 点，JSON 等附加按页另加），调用前需用 limit
 *   预估点数，剩余额度不足直接 402；
 *   map 按次计费（每次调用 1 点），只做链接发现不抓正文。
 *
 * 透传：formats（缺省按 format 映射 markdown/html）/ location（国家语言定向）/
 * proxy（auto/basic/stealth）/ timeout（毫秒，映射 perUrlTimeoutMs）。
 * output_format 不存在加价概念，形态只决定正文取哪个字段。
 *
 * 失败规则（按官方 errors 目录）：
 * - 401 无效密钥不可重试（抛 CREDENTIAL_MISSING）；
 *   402 余额不足不可重试；403 无权限/注入拦截不可重试；
 *   404 任务不存在不可重试；400/409/413/422 不可重试。
 * - 408 超时 / 429 限流并发 / 5xx 可重试（429 需尊重 Retry-After 退避，
 *   退避由调用方/网关层执行，本层只标记 retryable:true）。
 *
 * 零运行时依赖，原生 ESM，仅用全局 fetch；不打日志，不打印密钥。
 */

// 默认抓取端点（deps.fetchUrlFirecrawl / deps.firecrawlFetchUrl 优先）。
const DEFAULT_FETCH_URL = 'https://api.firecrawl.dev/v2/scrape';

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
 * 从 deps 解析 Firecrawl 密钥与抓取地址（空串视为缺失）。
 * @param {any} deps 依赖（含密钥与端点地址）
 * @returns {{apiKey: string, url: string}} 密钥与地址
 */
function resolveFirecrawl(deps) {
  const apiKey =
    (deps &&
      (deps.firecrawlApiKey ||
        deps.firecrawlKey ||
        deps.FIRECRAWL_API_KEY)) ||
    '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 FIRECRAWL_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.fetchUrlFirecrawl || deps.firecrawlFetchUrl)) || DEFAULT_FETCH_URL;
  return { apiKey, url };
}

/**
 * 归一 formats：调用方显式 formats 优先，否则按统一 format 映射。
 * @param {any} params 统一抓取输入
 * @returns {Array<any>} 上游 formats 数组
 */
function resolveFormats(params) {
  const raw = params.formats ?? params.formatList;
  if (Array.isArray(raw) && raw.length > 0) return raw.slice(0, 8);
  const f = params.format;
  if (f === 'html') return ['html'];
  if (f === 'text') return ['markdown'];
  return ['markdown'];
}

/**
 * 估算单页点数：基础 1 点，JSON/query/highlights 等附加形态各加 4 点。
 * @param {Array<any>} formats 上游 formats 数组
 * @param {any} params 统一抓取输入（读注入检查/PII/音视频等开关）
 * @returns {number} 预估点数
 */
function estimateCost(formats, params) {
  let cost = 1;
  for (const f of formats) {
    const t = typeof f === 'string' ? f.toLowerCase() : String((f && f.type) || '').toLowerCase();
    // JSON 结构化抽取 / query 问答 / highlights 相关片段各加 4 点。
    if (t === 'json' || t === 'query' || t === 'highlights' || t === 'summary') cost += 4;
    // 音视频抽取各加 4 点。
    else if (t === 'audio' || t === 'video') cost += 4;
  }
  // 提示注入检查 / PII 脱敏各加 4 点（开关在顶层或 scrapeOptions 下）。
  const checkInjection =
    params.checkPromptInjection ?? params.check_prompt_injection ?? params?.scrapeOptions?.checkPromptInjection;
  if (checkInjection === true || checkInjection === 'true') cost += 4;
  const pii =
    params.piiRedaction ?? params.pii_redaction ?? params?.scrapeOptions?.piiRedaction;
  if (pii === true || pii === 'true') cost += 4;
  return cost;
}

/**
 * 从上游单页 data 拼装正文：markdown > text > html > rawHtml。
 * @param {any} data 上游 data 对象
 * @returns {string} 归一正文
 */
function pickContent(data) {
  if (!data || typeof data !== 'object') return '';
  const v =
    data.markdown ?? data.text ?? data.content ?? data.html ?? data.rawHtml ?? '';
  return typeof v === 'string' ? v : String(v || '');
}

/**
 * 抓取单条 URL（内部扇出单元）。
 * @param {string} target 目标 URL
 * @param {any} body 上游请求体（不含 url）
 * @param {number} cost 预估点数
 * @param {string} apiKey 密钥
 * @param {string} endpoint 抓取端点
 * @param {(url: string, init?: any) => Promise<Response>} fetchImpl 抓取实现
 * @returns {Promise<{item: {url: string, finalUrl: string, title: string, content: string, publishedDate?: string}, billed: number}>} 归一成功项与实扣点数
 */
async function fetchSingle(target, body, cost, apiKey, endpoint, fetchImpl) {
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ ...body, url: target }),
    });
  } catch (cause) {
    throw fail('UPSTREAM_UNAVAILABLE', 'Firecrawl 抓取请求失败：' + target, {
      retryable: true,
    });
  }

  if (res.status === 401) {
    throw fail('CREDENTIAL_MISSING', 'Firecrawl 密钥无效或无权限', {
      status: 401,
      retryable: false,
    });
  }
  if (res.status === 402) {
    throw fail('INSUFFICIENT_CREDIT', 'Firecrawl 余额不足', {
      status: 402,
      retryable: false,
    });
  }
  if (res.status === 403) {
    // 无权限或注入拦截：不可重试。
    throw fail('UPSTREAM_FORBIDDEN', 'Firecrawl 拒绝访问（403）：' + target, {
      status: 403,
      retryable: false,
    });
  }
  if (res.status === 404) {
    throw fail('page_not_found', 'Firecrawl 资源不存在（404）：' + target, {
      status: 404,
      retryable: false,
    });
  }
  if (res.status === 429) {
    throw fail('UPSTREAM_RATE_LIMITED', 'Firecrawl 限流/并发超限（429）：' + target, {
      status: 429,
      retryable: true,
    });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Firecrawl 抓取异常：' + target + ' HTTP ' + res.status, {
      status: res.status,
      retryable: res.status === 408 || res.status >= 500,
    });
  }

  // 上游响应形状动态，压 any 后再取值。
  const data = /** @type {any} */ (await res.json());
  const doc = data && (data.data || data.document || data.result);
  // 无结果不计费：success:false 或空 data，直接可重试/按包内错误归类。
  if (!data || data.success === false || !doc) {
    const msg = String((data && data.error) || 'empty_result');
    const retryable = /timeout|rate|429|5\d\d|408/i.test(msg) ? true : false;
    throw fail('EMPTY_RESULT', 'Firecrawl 无结果（不计费）：' + target + ' ' + msg, {
      retryable,
    });
  }
  const meta = (doc && doc.metadata) || {};
  const pageStatus =
    typeof meta.statusCode === 'number'
      ? meta.statusCode
      : typeof meta.statusCode === 'string' && meta.statusCode
        ? Number(meta.statusCode)
        : undefined;
  // 页面层失败但有文档仍计 1 点：读状态止损，不可重试。
  if (typeof pageStatus === 'number' && !(pageStatus === 200 || pageStatus === 304 || (pageStatus >= 200 && pageStatus < 300))) {
    if (pageStatus === 404) {
      throw fail('page_not_found', 'Firecrawl 目标页不存在（仍计 1 点）：' + target, {
        status: 404,
        retryable: false,
      });
    }
    if (pageStatus === 403) {
      throw fail('UPSTREAM_FORBIDDEN', 'Firecrawl 目标页拒绝访问（仍计 1 点）：' + target, {
        status: 403,
        retryable: false,
      });
    }
    throw fail('TARGET_HTTP_ERROR', 'Firecrawl 目标页异常（仍计费）：' + target + ' 页面 ' + pageStatus, {
      status: pageStatus,
      retryable: pageStatus === 408 || pageStatus >= 500,
    });
  }

  const sourceUrl = String(meta.sourceURL || meta.url || target);
  const out = /** @type {any} */ ({
    url: target,
    finalUrl: sourceUrl,
    title: String(meta.title || doc.title || ''),
    content: pickContent(doc),
  });
  const published =
    meta.publishedDate || meta.published_date || meta.publishDate || doc.publishedDate;
  if (typeof published === 'string' && published) out.publishedDate = published;
  return { item: out, billed: cost };
}

/**
 * Firecrawl 批量抓取（单页扇出合并）。
 * @param {{urls: string[], format?: string, formats?: Array<any>, formatList?: Array<any>, location?: any, proxy?: string, timeout?: number, perUrlTimeoutMs?: number, ttl?: number, maxAge?: number, onlyMainContent?: boolean, checkPromptInjection?: boolean, piiRedaction?: boolean}} params
 *   统一抓取输入（urls 1..10；format 映射 formats；location 地理定向；
 *   proxy 代理档；timeout/perUrlTimeoutMs 超时毫秒；ttl/maxAge 缓存毫秒透传 maxAge）
 * @param {any} deps 依赖（含 firecrawlApiKey、fetchUrlFirecrawl、fetchImpl）
 * @returns {Promise<{results: Array<{url: string, finalUrl: string, title: string, content: string, publishedDate?: string}>, errors: Array<{url: string, error: string, status?: number, retryable: boolean}>, usage?: any}>}
 *   归一后的成功与失败列表（usage 含预估与实扣点数）
 */
export async function firecrawlFetch(params, deps) {
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
  const { apiKey, url } = resolveFirecrawl(deps);

  const formats = resolveFormats(params);
  // 代理档：仅 auto/basic/stealth 透传，其余忽略。
  const proxyRaw = typeof params.proxy === 'string' ? params.proxy.trim().toLowerCase() : '';
  const proxy = proxyRaw === 'auto' || proxyRaw === 'basic' || proxyRaw === 'stealth' ? proxyRaw : undefined;
  // 地理定向：对象或字符串原样透传（country/languages 等由上游校验）。
  const location = params.location !== undefined ? params.location : undefined;
  // 超时：timeout 与 perUrlTimeoutMs 均为毫秒，取正整数透传。
  let timeout;
  const timeoutRaw = params.timeout ?? params.perUrlTimeoutMs;
  if (timeoutRaw !== undefined) {
    const n = Number(timeoutRaw);
    if (Number.isFinite(n) && n > 0) timeout = Math.floor(n);
  }
  // 缓存：ttl/maxAge 毫秒映射为上游 maxAge。
  let maxAge;
  const ageRaw = params.maxAge ?? params.max_age ?? params.ttl;
  if (ageRaw !== undefined) {
    const n = Number(ageRaw);
    if (Number.isFinite(n) && n >= 0) maxAge = Math.floor(n);
  }
  const onlyMainContent =
    params.onlyMainContent ?? params.only_main_content ?? undefined;

  // 上游请求体动态组装（location/proxy/timeout/maxAge 按需透传），压 any。
  const body = /** @type {any} */ ({ formats });
  if (proxy !== undefined) body.proxy = proxy;
  if (location !== undefined) body.location = location;
  if (timeout !== undefined) body.timeout = timeout;
  if (maxAge !== undefined) body.maxAge = maxAge;
  if (onlyMainContent !== undefined) body.onlyMainContent = !!onlyMainContent;

  const cost = estimateCost(formats, params);

  // 单批扇出：逐 URL 结算，成功进 results，失败进 errors，费用累加进 usage。
  const settled = /** @type {any[]} */ (
    await Promise.all(
      urls.map(async (/** @type {any} */ target) => {
        try {
          const done = await fetchSingle(String(target), body, cost, apiKey, url, fetchImpl);
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
  let billedCredits = 0;
  for (const entry of settled) {
    if (entry.ok) {
      results.push(entry.value.item);
      billedCredits += entry.value.billed || 0;
    } else {
      // 清理 undefined 状态码，保持 errors[] 形状干净。
      const e = /** @type {any} */ ({
        url: entry.value.url,
        error: entry.value.error,
        retryable: entry.value.retryable,
      });
      if (entry.value.status !== undefined) e.status = entry.value.status;
      errors.push(e);
    }
  }
  // usage 透出难度加权预估与实扣（无结果不计费，故实扣按成功项累加）。
  const usage = /** @type {any} */ ({
    provider: 'firecrawl',
    estimatedCredits: cost * urls.length,
    billedCredits,
  });
  return { results, errors, usage };
}
