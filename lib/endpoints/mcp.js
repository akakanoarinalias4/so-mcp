/**
 * MCP 端点：`/mcp` 的 Streamable HTTP 入口（无状态本地实现）。
 * 仅 POST 承载 JSON-RPC；GET 固定回 405、DELETE 固定回 400。
 */
import { MAX_REQUEST_BYTES, resolveDeps } from '../config.js';
import { gate } from '../gate.js';
import { jsonResponse, methodNotAllowed, payloadTooLarge } from '../http.js';
import { handleMcpRequest } from '../mcp.js';

/** 允许的方法集合，OPTIONS 由准入层直接回预检。 */
const METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS'];

/**
 * 处理 MCP 请求：鉴权后按方法分发，全部自研回包走统一响应。
 * @param {Request} request 客户端请求
 * @param {any} [input] 依赖注入（环境变量与 fetch 实现）
 * @returns {Promise<Response>} 待发送的响应
 */
export async function handleMcp(request, input) {
  const url = new URL(request.url);
  const deps = resolveDeps(input);
  const gated = gate(request, url, deps.resolved, METHODS);
  if (gated.response) return gated.response;

  // 仅 POST 可调：GET 明确拒绝并告知 Allow。
  if (request.method === 'GET') {
    return methodNotAllowed(request, 'POST');
  }
  // 无状态服务没有可终止的会话，DELETE 固定回 400。
  if (request.method === 'DELETE') {
    return jsonResponse(
      request,
      { success: false, error: 'no_session', error_description: 'No active session to terminate.' },
      { status: 400 },
    );
  }

  // POST：先做 4MB 限长读取，超限直接回 413。
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader !== null && Number(lengthHeader) > MAX_REQUEST_BYTES) {
    return payloadTooLarge(request, MAX_REQUEST_BYTES);
  }
  /** @type {ArrayBuffer} */
  let raw;
  try {
    raw = await request.arrayBuffer();
  } catch {
    return jsonResponse(
      request,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }
  if (raw.byteLength > MAX_REQUEST_BYTES) {
    return payloadTooLarge(request, MAX_REQUEST_BYTES);
  }
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonResponse(
      request,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }

  const result = await handleMcpRequest(body, deps);
  // 通知（无 id）按 JSON-RPC 约定回 202 空确认。
  if (result === undefined) {
    return jsonResponse(request, null, { status: 202 });
  }
  return jsonResponse(request, result);
}
