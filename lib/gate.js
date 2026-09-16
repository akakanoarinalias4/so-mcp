/**
 * 请求准入的唯一归属：部署配置、HTTP 方法、客户端凭证。
 * 每个需鉴权的端点都从这里开始，检查顺序与失败形状统一收敛于此，
 * 通过校验的凭证交还端点继续处理。
 */

import { collectPresentedKeys, matchCredential } from './auth.js';
import {
  methodNotAllowed,
  misconfiguredResponse,
  preflightResponse,
  unauthorized,
} from './http.js';

/**
 * 准入检查：OPTIONS 预检 / 缺配 / 方法 / 凭证。
 *
 * @param {Request} request
 * @param {URL} url
 * @param {import('./config.js').ConfigResolution} resolved
 * @param {string[]} allowedMethods 该路由允许的方法集合。
 * @returns {{ response?: Response, credential?: string }} 有 response 时直接返回、
 *          不再触碰上游；否则 credential 为客户端通过鉴权的代理密钥。
 */
export function gate(request, url, resolved, allowedMethods) {
  if (request.method === 'OPTIONS') return { response: preflightResponse(request, allowedMethods) };
  if (!resolved.ok) return { response: misconfiguredResponse(request, resolved.missing) };
  if (!allowedMethods.includes(request.method)) {
    return { response: methodNotAllowed(request, allowedMethods.join(', ')) };
  }

  const presented = collectPresentedKeys(request, url);
  if (presented.length === 0) return { response: unauthorized(request, 'missing_api_key') };

  const credential = matchCredential(presented, resolved.config.proxyApiKey);
  if (!credential) return { response: unauthorized(request, 'invalid_api_key') };

  return { credential };
}
