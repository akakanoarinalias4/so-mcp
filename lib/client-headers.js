/**
 * 客户端响应头策略的唯一归属：转回哪些头、浏览器可读哪些头、
 * CORS 与缓存默认值。每份发往客户端的响应都经过这里。
 *
 * 只放行 MCP 必需的少数头，避免客户端凭证 / Cookie 被转交或伪造；
 * 客户端的 user-agent / accept-language 不会转发给上游。
 */

/**
 * 代理接受的客户端请求头（用于 CORS 预检声明）。
 * authorization / x-api-key 只用于本代理鉴权，不会转发上游。
 */
const ALLOWED_REQUEST_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'x-api-key',
].join(', ');

/** 允许回传给客户端的上游响应头（本代理只透出 MCP 必需项）。 */
export const RELAYED_UPSTREAM_HEADERS = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];

/**
 * 当前请求的 CORS 头。Origin 宽松回显（永不用 *），
 * 携带凭证的浏览器 MCP 客户端仍可工作。
 *
 * @param {Request} request
 * @param {string[]} [allowedMethods] 仅预检时传入：该路由自身的方法集合。
 * @returns {Record<string, string>}
 */
export function corsHeaders(request, allowedMethods) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  /** @type {Record<string, string>} */
  const headers = {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': ALLOWED_REQUEST_HEADERS,
    'access-control-expose-headers': RELAYED_UPSTREAM_HEADERS.join(', '),
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (allowedMethods) headers['access-control-allow-methods'] = allowedMethods.join(', ');
  return headers;
}

/**
 * 补齐客户端响应头：应用 CORS 策略，未显式设置缓存策略时默认 no-store。
 *
 * @param {Request} request
 * @param {Headers} headers
 * @returns {Headers}
 */
export function applyClientHeaders(request, headers) {
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return headers;
}
