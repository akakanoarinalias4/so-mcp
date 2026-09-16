/**
 * 余额查询层：Linkup 剩余额度与 Tinyfish 钱包。
 *
 * 密钥只读服务端环境变量（经 deps 传入），永不回传客户端、不打日志。
 * 失败统一抛 {code, status} 结构化错误，由网关映射为上游不可用/超时。
 * 零运行时依赖，原生 ESM，仅用全局 fetch。
 */

// 默认余额端点（deps.creditsUrlLinkup / deps.tinyfishWalletUrl 优先）。
// 钱包与智能体同宿主（agent.tinyfish.ai），与抓取宿主分离（抓取与搜索为独立产品宿主）。
const DEFAULT_LINKUP_BALANCE_URL = 'https://api.linkup.so/v1/credits/balance';
const DEFAULT_TINYFISH_WALLET_URL = 'https://agent.tinyfish.ai/v1/wallet';

// 余额查询独立超时（毫秒），避免 Hobby 函数被上游拖住。
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 构造携带结构化字段的错误。
 * @param {string} code 错误码
 * @param {string} message 错误信息
 * @param {{status?: number}} [extra] 附加字段
 * @returns {Error & {code: string, status?: number}} 结构化错误
 */
function fail(code, message, extra) {
  const err = /** @type {Error & {code: string, status?: number}} */ (
    new Error(message)
  );
  err.code = code;
  if (extra && extra.status !== undefined) err.status = extra.status;
  return err;
}

/**
 * 解析超时毫秒数。
 * @param {any} deps 依赖
 * @returns {number} 超时毫秒数
 */
function resolveTimeoutMs(deps) {
  const raw =
    (deps && (deps.creditsTimeoutMs || deps.CREDITS_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(ms);
}

/**
 * 带独立超时的 GET 请求。
 * @param {string} url 请求地址
 * @param {Record<string, string>} headers 请求头
 * @param {number} timeoutMs 超时毫秒数
 * @param {(url: string, init?: any) => Promise<Response>} [fetchImpl] 注入的抓取实现（缺省全局 fetch）
 * @returns {Promise<Response>} 上游响应
 */
async function getWithTimeout(url, headers, timeoutMs, fetchImpl) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const impl = fetchImpl ?? globalThis.fetch;
  /** @type {AbortController|undefined} */
  let controller;
  /** @type {any} */
  let signal;
  try {
    // Node 22 原生支持超时信号；不支持时降级为普通请求。
    signal = AbortSignal.timeout(timeoutMs);
  } catch (_ignored) {
    controller = new AbortController();
    signal = controller.signal;
    // 降级分支内控制器必已赋值，转 any 后调用，避免闭包 possibly-undefined 报错（运行时逻辑不变）。
    setTimeout(() => /** @type {any} */ (controller).abort(), timeoutMs).unref?.();
  }
  try {
    return await impl(url, { method: 'GET', headers, signal });
  } catch (cause) {
    // 上游异常形状动态，转 any 后再取 name，避免隐式 any 报错。
    const causeAny = /** @type {any} */ (cause);
    const aborted =
      (cause && (causeAny.name === 'TimeoutError' || causeAny.name === 'AbortError')) || false;
    if (aborted) {
      throw fail('UPSTREAM_TIMEOUT', '余额查询超时：' + url, { status: 504 });
    }
    throw fail('UPSTREAM_UNAVAILABLE', '余额查询请求失败：' + url, { status: 502 });
  }
}

/**
 * 查询 Linkup 剩余额度。
 * @param {any} deps 依赖（含 linkupApiKey、creditsUrlLinkup、creditsTimeoutMs）
 * @returns {Promise<{provider: 'linkup', balance: number}>} 剩余额度
 */
export async function getLinkupBalance(deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const apiKey =
    (deps && (deps.linkupApiKey || deps.linkupKey || deps.LINKUP_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 LINKUP_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.creditsUrlLinkup || deps.linkupBalanceUrl)) ||
    DEFAULT_LINKUP_BALANCE_URL;
  const res = await getWithTimeout(
    url,
    { Authorization: 'Bearer ' + apiKey },
    resolveTimeoutMs(deps),
    fetchImpl,
  );
  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Linkup 密钥无效或无权限', { status: res.status });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Linkup 余额查询异常：HTTP ' + res.status, {
      status: res.status,
    });
  }
  // 上游余额响应形状动态，压为 any 后再取值，避免隐式 any 报错。
  const data = /** @type {any} */ (await res.json());
  const balance = Number((/** @type {any} */ (data)) && ((/** @type {any} */ (data)).balance ?? (/** @type {any} */ (data)).credits ?? (/** @type {any} */ (data)).remaining));
  if (!Number.isFinite(balance)) {
    throw fail('UPSTREAM_ERROR', 'Linkup 余额响应缺少 balance 字段', {
      status: 502,
    });
  }
  return { provider: 'linkup', balance };
}

/**
 * 查询 Tinyfish 钱包。
 * @param {any} deps 依赖（含 tinyfishApiKey、tinyfishWalletUrl、creditsTimeoutMs）
 * @returns {Promise<{provider: 'tinyfish', wallet: unknown}>} 钱包原文
 */
export async function getTinyfishWallet(deps) {
  // 优先使用调用方注入的抓取实现，便于单测打桩；缺省回退全局 fetch。
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const apiKey =
    (deps && (deps.tinyfishApiKey || deps.tinyfishKey || deps.TINYFISH_API_KEY)) || '';
  if (!apiKey) {
    throw fail('CREDENTIAL_MISSING', '缺少 TINYFISH_API_KEY 服务端环境变量');
  }
  const url =
    (deps && (deps.tinyfishWalletUrl || deps.creditsUrlTinyfish)) ||
    DEFAULT_TINYFISH_WALLET_URL;
  const res = await getWithTimeout(
    url,
    { 'X-API-Key': apiKey },
    resolveTimeoutMs(deps),
    fetchImpl,
  );
  if (res.status === 401 || res.status === 403) {
    throw fail('CREDENTIAL_MISSING', 'Tinyfish 密钥无效或无权限', {
      status: res.status,
    });
  }
  if (!res.ok) {
    throw fail('UPSTREAM_ERROR', 'Tinyfish 钱包查询异常：HTTP ' + res.status, {
      status: res.status,
    });
  }
  // 上游钱包响应形状动态（wallet 或原文），压为 any 后再取值，避免隐式 any 报错。
  const data = /** @type {any} */ (await res.json());
  const wallet = (/** @type {any} */ (data)) && (/** @type {any} */ (data)).wallet !== undefined ? (/** @type {any} */ (data)).wallet : data;
  return { provider: 'tinyfish', wallet };
}
