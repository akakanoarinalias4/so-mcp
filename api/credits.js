// /credits 薄转发：把请求交给端点处理。
import { handleCredits } from '../lib/endpoints/credits.js';
/** @type {{ fetch: (request: Request) => Promise<Response> }} 薄转发：把请求交给端点处理。 */
export default {
  fetch: (request) => handleCredits(request),
};
