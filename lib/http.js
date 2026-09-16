/**
 * 本代理自己发明的响应形状的唯一归属：JSON 错误包、预检、
 * 405 / 413 / 500 / 502 / 504。客户端头策略见 ./client-headers.js。
 *
 * 错误码保持英文（missing_api_key 等），便于客户端按码处理；
 * 错误描述主体使用中文。
 */

import { applyClientHeaders, corsHeaders } from './client-headers.js';
import { misconfigurationMessage } from './config.js';

/**
 * 响应头袋。
 *
 * @typedef {Headers | Record<string, string> | [string, string][]} HeadersLike
 */

/**
 * 返回 JSON 响应，自动附加 CORS / no-store 客户端头。
 *
 * @param {Request} request
 * @param {unknown} body
 * @param {{ status?: number, headers?: HeadersLike }} [init]
 * @returns {Response}
 */
export function jsonResponse(request, body, init = {}) {
  const headers = applyClientHeaders(request, new Headers(init.headers));
  return Response.json(body, { status: init.status ?? 200, headers });
}

/**
 * 返回统一 JSON 错误包 { success: false, error, error_description }。
 *
 * @param {Request} request
 * @param {number} status HTTP 状态码。
 * @param {string} error 错误码（英文，保持稳定）。
 * @param {string} description 错误描述（中文）。
 * @param {{ headers?: HeadersLike }} [init]
 * @returns {Response}
 */
export function jsonError(request, status, error, description, init = {}) {
  return jsonResponse(
    request,
    { success: false, error, error_description: description },
    { status, headers: init.headers },
  );
}

/**
 * 回答 CORS 预检，不触碰鉴权与上游。
 *
 * @param {Request} request
 * @param {string[]} allowedMethods 该路由自身的方法集合（与 405 声明一致）。
 * @returns {Response}
 */
export function preflightResponse(request, allowedMethods) {
  return new Response(null, { status: 204, headers: corsHeaders(request, allowedMethods) });
}

/**
 * 405 方法不允许。
 *
 * @param {Request} request
 * @param {string} allow 允许的方法列表字符串（如 'POST'）。
 * @returns {Response}
 */
export function methodNotAllowed(request, allow) {
  return jsonError(request, 405, 'method_not_allowed', `不支持的请求方法，仅允许：${allow}。`, {
    headers: { allow },
  });
}

/**
 * 401 鉴权失败，附带标准 WWW-Authenticate 挑战头。
 *
 * @param {Request} request
 * @param {'missing_api_key' | 'invalid_api_key'} code
 * @returns {Response}
 */
export function unauthorized(request, code) {
  const description =
    code === 'missing_api_key'
      ? '未提供代理密钥。请经由 Authorization: Bearer <PROXY_API_KEY>、x-api-key 请求头或 ?apiKey= 查询参数提供。'
      : '提供的代理密钥无效，必须与本部署的 PROXY_API_KEY 一致。请勿填写上游密钥。';
  return jsonError(request, 401, code, description, {
    headers: {
      'www-authenticate': `Bearer error="invalid_token", error_description="${code}"`,
    },
  });
}

/**
 * 500 部署缺配：环境变量缺失。
 *
 * @param {Request} request
 * @param {string[]} missing 缺失的环境变量名。
 * @returns {Response}
 */
export function misconfiguredResponse(request, missing) {
  return jsonError(request, 500, 'proxy_misconfigured', misconfigurationMessage(missing));
}

/**
 * 502 上游不可达或连接中途断开。
 *
 * @param {Request} request
 * @param {unknown} error
 * @returns {Response}
 */
export function upstreamUnavailable(request, error) {
  const cause = error instanceof Error ? error.message : String(error);
  return jsonError(
    request,
    502,
    'upstream_unavailable',
    `无法连通上游服务：${cause}`,
    { headers: { 'retry-after': '5' } },
  );
}

/**
 * 504 上游在调用方设定的时限内未应答。
 *
 * @param {Request} request
 * @param {string} description 中文超时说明。
 * @returns {Response}
 */
export function upstreamTimeout(request, description) {
  return jsonError(request, 504, 'upstream_timeout', description);
}

/**
 * 413 请求体超限。
 *
 * @param {Request} request
 * @param {number} limit 字节上限。
 * @returns {Response}
 */
export function payloadTooLarge(request, limit) {
  return jsonError(
    request,
    413,
    'payload_too_large',
    `请求体超过本代理 ${limit} 字节上限，请拆小粒度重试。`,
  );
}
