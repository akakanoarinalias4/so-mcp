// /mcp 薄转发：把请求交给端点处理。
import { handleMcp } from '../lib/endpoints/mcp.js';
/** @type {{ fetch: (request: Request) => Promise<Response> }} 薄转发：把请求交给端点处理。 */
export default {
  fetch: (request) => handleMcp(request),
};
