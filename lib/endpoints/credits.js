/**
 * 余额端点：`GET /credits`，并行查询两家剩余额度。
 * 任一供应商缺 key 或失败都不阻塞另一家，分别记为可回传状态。
 */
import { CREDITS_TIMEOUT_MS, resolveDeps } from '../config.js';
import { getLinkupBalance, getTinyfishWallet } from '../credits.js';
import { gate } from '../gate.js';
import { jsonResponse, upstreamTimeout } from '../http.js';

/** 余额接口仅支持 GET，OPTIONS 由准入层直接回预检。 */
const METHODS = ['GET', 'OPTIONS'];

/**
 * 把供应商异常归一化为可回传的状态对象。
 * 缺 key（CREDENTIAL_MISSING）记 skipped，其余记 error，均保留 code/status 供排查。
 * @param {unknown} error 捕获到的异常或拒绝原因
 * @returns {any} 带 skipped 或 error 标记的状态对象
 */
function toStatus(error) {
  if (error && typeof error === 'object' && ('skipped' in error || 'error' in error)) {
    return error;
  }
  const code = (error != null && typeof error === 'object' && 'code' in error)
    ? String(/** @type {any} */ (error).code)
    : undefined;
  const status = (error != null && typeof error === 'object' && 'status' in error)
    ? /** @type {any} */ (error).status
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'CREDENTIAL_MISSING' || /missing|misconfig|no key|skipped|api.?key/i.test(message)) {
    return { skipped: true, code: code ?? 'CREDENTIAL_MISSING', error: message };
  }
  return { error: message, code: code ?? 'UPSTREAM_ERROR', ...(status !== undefined ? { status } : {}) };
}

/**
 * 处理余额查询：鉴权后并行查询两家，整体超时竞速。
 * @param {Request} request 客户端请求
 * @param {any} [input] 依赖注入（环境变量与 fetch 实现）
 * @returns {Promise<Response>} 待发送的响应
 */
export async function handleCredits(request, input) {
  const url = new URL(request.url);
  const deps = resolveDeps(input);
  const gated = gate(request, url, deps.resolved, METHODS);
  if (gated.response) return gated.response;

  // 供应商只认扁平键（deps.linkupApiKey 等）：把 resolved.config 拍平并透传 fetchImpl。
  const providerDeps = { ...deps, ...(deps.resolved?.config ?? {}), config: deps.resolved?.config };
  // 超时：优先用已解析配置里的 creditsTimeoutMs（其本身可被环境变量覆盖），再回退常量。
  const configured = /** @type {any} */ (deps.resolved.config)?.creditsTimeoutMs;
  const timeoutMs = Number.isFinite(Number(configured)) && Number(configured) > 0
    ? Number(configured)
    : CREDITS_TIMEOUT_MS;
  const work = (async () => {
    const [linkup, tinyfish] = await Promise.all([
      (async () => {
        try {
          return await getLinkupBalance(providerDeps);
        } catch (error) {
          return toStatus(error);
        }
      })(),
      (async () => {
        try {
          return await getTinyfishWallet(providerDeps);
        } catch (error) {
          return toStatus(error);
        }
      })(),
    ]);
    return jsonResponse(request, {
      success: true,
      data: { linkup, tinyfish },
      checkedAt: new Date().toISOString(),
    });
  })();

  /** @type {any} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('credits_timeout')), timeoutMs);
  });
  try {
    return /** @type {Response} */ (await Promise.race([work, timeout]));
  } catch {
    return upstreamTimeout(request, `Credit check did not finish within ${timeoutMs}ms.`);
  } finally {
    clearTimeout(timer);
  }
}
