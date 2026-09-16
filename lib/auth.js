/**
 * 客户端鉴权：本代理密钥的提取与恒定时间比对。
 *
 * 客户端只持有本代理的密钥（PROXY_API_KEY），可经由以下任一方式出示：
 *   - Authorization: Bearer <PROXY_API_KEY>
 *   - x-api-key: <PROXY_API_KEY>
 *   - ?apiKey=<PROXY_API_KEY>（无法设置请求头的客户端兜底）
 *
 * 出示值永不透传上游：上游密钥只从服务端环境变量注入。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** 可能携带本代理密钥的请求头，按优先级排序。 */
const API_KEY_HEADERS = ['x-api-key'];

/** 可能携带本代理密钥的查询参数名。 */
export const API_KEY_QUERY_PARAM = 'apiKey';

/**
 * 收集请求出示的全部本代理密钥候选。
 *
 * @param {Request} request
 * @param {URL} url
 * @returns {string[]}
 */
export function collectPresentedKeys(request, url) {
  /** @type {string[]} */
  const keys = [];
  for (const header of API_KEY_HEADERS) {
    const value = request.headers.get(header)?.trim();
    if (value) keys.push(value);
  }

  const authorization = request.headers.get('authorization')?.trim() ?? '';
  const bearer = /^bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (bearer) keys.push(bearer);

  const query = url.searchParams.get(API_KEY_QUERY_PARAM)?.trim();
  if (query) keys.push(query);
  return keys;
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
