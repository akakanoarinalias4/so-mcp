/**
 * lib/mcp.js
 * MCP 协议纯函数入口：initialize / tools.list / tools.call。
 * 不读 env、不做 IO，deps 由调用方（endpoint）注入。
 * 零运行时依赖，原生 ESM，变量名英文、注释与 JSDoc 中文。
 */

import { TOOL_DEFS, dispatchTool } from './tools.js';

/** 服务名与版本号（initialize 回 serverInfo 用）。 */
const SERVER_NAME = 'so-mcp';
const SERVER_VERSION = '1.0.0';
/** 默认协议版本（客户端未声明时使用）。 */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/**
 * 方法未找到的 JSON-RPC 错误码。
 * @type {number}
 */
const METHOD_NOT_FOUND = -32601;
/** 非法请求的 JSON-RPC 错误码。 */
const INVALID_REQUEST = -32600;
/** 解析失败的 JSON-RPC 错误码。 */
const PARSE_ERROR = -32700;

/**
 * 构造 JSON-RPC 成功响应。
 * @param {any} id 请求 id
 * @param {any} result 结果负载
 * @returns {{jsonrpc: string, id: any, result: any}} 成功响应对象
 */
function successResponse(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * 构造 JSON-RPC 错误响应。
 * @param {any} id 请求 id
 * @param {number} code 错误码
 * @param {string} message 错误信息
 * @param {any} [data] 附加数据
 * @returns {{jsonrpc: string, id: any, error: object}} 错误响应对象
 */
function errorResponse(id, code, message, data) {
  const error = /** @type {any} */ ({ code, message });
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * 处理单个 JSON-RPC 请求对象。
 * @param {any} body 单个请求对象
 * @param {any} deps 调用方注入的依赖（透传 dispatchTool）
 * @returns {Promise<any|undefined>} 响应对象；notification（无 id）返回 undefined
 */
async function handleSingleRequest(body, deps) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(null, INVALID_REQUEST, '非法请求');
  }
  const method = body.method;
  const id = body.id ?? null;
  const params = /** @type {any} */ (body.params && typeof body.params === 'object' ? body.params : {});
  const hasId = body.id !== undefined && body.id !== null;

  // Notification（无 id）：按 JSON-RPC 规范不回包。
  if (typeof method !== 'string') {
    if (!hasId) return undefined;
    return errorResponse(id, INVALID_REQUEST, '非法请求');
  }

  switch (method) {
    case 'initialize': {
      const protocolVersion =
        typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
      return successResponse(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }

    case 'notifications/initialized':
      // 初始化完成通知，无需回包。
      return undefined;

    case 'ping':
      return successResponse(id, {});

    case 'tools/list':
      return successResponse(id, { tools: TOOL_DEFS });

    case 'tools/call': {
      const toolName = params.name;
      const toolArgs = /** @type {any} */ (params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
      if (typeof toolName !== 'string' || toolName.length === 0) {
        return errorResponse(id, INVALID_REQUEST, 'tools/call 缺少工具名');
      }
      try {
        const result = await dispatchTool(toolName, toolArgs, deps);
        return successResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        });
      } catch (toolError) {
        // 工具执行失败包 isError:true 的 result，而非 JSON-RPC error。
        const message = toolError instanceof Error ? toolError.message : String(toolError);
        return successResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
          isError: true,
        });
      }
    }

    default:
      // 未知方法回 -32601（notification 则不回包）。
      if (!hasId) return undefined;
      return errorResponse(id, METHOD_NOT_FOUND, `未知方法: ${method}`);
  }
}

/**
 * MCP 请求纯函数入口。
 * 入参为 endpoint 已解析的 body（对象或 batch 数组；string 会尝试 JSON.parse 兜底）。
 * 返回 plain object（或 batch 数组、notification 的 undefined），由 endpoint 包 jsonResponse。
 * 永不抛异常、不返回 Response、不读 env。
 * @param {any} body 已解析的 JSON-RPC 请求体
 * @param {any} [deps] 调用方注入的依赖（透传 dispatchTool）
 * @returns {Promise<any|undefined>} JSON-RPC 响应对象 / 数组 / undefined
 */
export async function handleMcpRequest(body, deps) {
  let parsed = body;
  // 兜底：endpoint 透传 string 时尝试解析，失败回解析错误。
  if (typeof parsed === 'string') {
    const text = parsed.trim();
    if (!text) return errorResponse(null, INVALID_REQUEST, '空请求体');
    try {
      parsed = JSON.parse(text);
    } catch {
      return errorResponse(null, PARSE_ERROR, '请求体 JSON 解析失败');
    }
  }

  // Batch 请求：逐个处理后合并（过滤 notification 的 undefined）。
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return errorResponse(null, INVALID_REQUEST, '非法批量请求');
    }
    const responses = [];
    for (const item of parsed) {
      const single = await handleSingleRequest(item, deps);
      if (single !== undefined) responses.push(single);
    }
    if (responses.length === 0) return undefined;
    return responses;
  }

  return await handleSingleRequest(parsed, deps);
}
