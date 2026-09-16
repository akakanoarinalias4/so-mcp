/**
 * 客户端鉴权：本代理密钥的提取与恒定时间比对。
 *
 * 客户端持有本代理的密钥（PROXY_API_KEY），唯一出示方式为：
 *   - Authorization: Bearer <PROXY_API_KEY>
 *
 * 出示值永不透传上游：上游密钥只从服务端环境变量注入。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 废弃的查询参数名：仅为兼容旧导入而保留，恒为空串。
 * 鉴权不再读取请求地址，任何旧查询参数一律视作未提供。
 * @deprecated 请改用 Authorization: Bearer 请求头。
 */
export const API_KEY_QUERY_PARAM = '';

/**
 * 收集请求出示的本代理密钥候选：仅解析 authorization 头中的持有者令牌。
 * 无令牌回空数组，有令牌回单元素数组。
 *
 * @param {Request} request
 * @returns {string[]}
 */
export function collectPresentedKeys(request) {
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  const bearer = /^bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  return bearer ? [bearer] : [];
}

/**
 * 恒定时间比较，同时隐藏长度差异（先做 sha256 再比对摘要）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEquals(a, b) {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * 返回通过鉴权的出示凭证，未通过返回 undefined。
 *
 * 故意与全部候选逐一比对，避免响应时长泄露匹配的密钥来自哪个位置。
 *
 * @param {readonly string[]} presentedKeys
 * @param {string} expectedKey
 * @returns {string | undefined}
 */
export function matchCredential(presentedKeys, expectedKey) {
  if (!expectedKey) return undefined;
  /** @type {string | undefined} */
  let credential;
  for (const candidate of presentedKeys) {
    if (constantTimeEquals(candidate, expectedKey)) credential ??= candidate;
  }
  return credential;
}
