/**
 * lib/tools.js
 * MCP 工具定义与分发：so_search / so_fetch / so_verify。
 * 零运行时依赖，原生 ESM，变量名英文、注释与 JSDoc 中文。
 */

import { getSearchProvider, getFetchProvider } from './providers/index.js';

/**
 * 统一搜索输入形状。
 * @typedef {object} UnifiedSearchInput
 * @property {string} query 搜索关键词
 * @property {string} [depth] flash|fast|standard|deep
 * @property {string} [outputType] searchResults|sourcedAnswer|structured
 * @property {string} [fromDate] 起始日期 YYYY-MM-DD
 * @property {string} [toDate] 结束日期 YYYY-MM-DD
 * @property {number} [maxResults] 最大结果数
 * @property {string[]} [includeDomains] 限定域名
 * @property {string[]} [excludeDomains] 排除域名
 */

/**
 * 统一抓取输入形状。
 * @typedef {object} UnifiedFetchInput
 * @property {string[]} urls 待抓取地址（1..10 条）
 * @property {string} [format] markdown|html
 * @property {number} [ttl] 缓存秒数
 * @property {number} [perUrlTimeoutMs] 单地址超时毫秒
 */

/**
 * 调用方注入的依赖（lib/config.js 的 resolveDeps 产物或其 Config）。
 * 兼容三种形态：{resolved:{config}}（端点透传）、{config}、扁平 Config 本体；
 * 下游供应商统一经 resolveProviderDeps 拍平后调用。
 * @typedef {object} ToolDeps
 * @property {object} [config] 直挂配置
 * @property {{config?: object}} [resolved] resolveDeps 的 resolved 包
 * @property {string} [searchProvider] 扁平形态直挂字段（兼容用）
 * @property {string} [fetchPrimary] 扁平形态直挂字段（兼容用）
 * @property {string} [fetchFallback] 扁平形态直挂字段（兼容用）
 * @property {string} [linkupApiKey] 扁平形态直挂密钥（兼容用）
 * @property {string} [tinyfishApiKey] 扁平形态直挂密钥（兼容用）
 */

/**
 * 三个 MCP 工具的 JSON Schema 定义（供 tools/list 直接返回）。
 * 工具名固定：so_search、so_fetch、so_verify。
 * @type {Array<{name: string, description: string, inputSchema: object}>}
 */
export const TOOL_DEFS = [
  {
    name: 'so_search',
    description: '统一搜索：默认 Linkup，可扩展多供应商。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        depth: { type: 'string', enum: ['flash', 'fast', 'standard', 'deep'] },
        outputType: { type: 'string', enum: ['searchResults', 'sourcedAnswer', 'structured'] },
        fromDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        toDate: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        includeDomains: { type: 'array', items: { type: 'string' } },
        excludeDomains: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
      additionalProperties: true,
    },
  },
  {
    name: 'so_fetch',
    description: '统一抓取：主 Tinyfish，失败回退 Linkup。',
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 10,
          description: '待抓取地址（1..10 条）',
        },
        format: { type: 'string', enum: ['markdown', 'html'] },
        ttl: { type: 'integer', minimum: 0 },
        perUrlTimeoutMs: { type: 'integer', minimum: 1000 },
      },
      required: ['urls'],
      additionalProperties: true,
    },
  },
  {
    name: 'so_verify',
    description: '时效多信源交叉验证：搜索取多源，去重计数并抓取验时效。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '待验证问题或主题' },
        fromDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        toDate: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        depth: { type: 'string', enum: ['flash', 'fast', 'standard', 'deep'] },
      },
      required: ['query'],
      additionalProperties: true,
    },
  },
];

/**
 * 从多种 deps 形态中提取统一 Config。
 * 优先级：deps.config > deps.resolved.config > deps 本体扁平字段。
 * @param {any} deps 调用方注入的依赖
 * @returns {Record<string, any>} 归一化配置（恒为对象）
 */
function resolveToolConfig(deps) {
  const fromConfig = deps && typeof deps === 'object' ? deps.config : undefined;
  const fromResolved = deps && typeof deps === 'object' ? deps.resolved?.config : undefined;
  const flat = deps && typeof deps === 'object' ? deps : {};
  /** @type {Record<string, any>} */
  const merged = {
    searchProvider: undefined,
    fetchPrimary: undefined,
    fetchFallback: undefined,
    linkupApiKey: undefined,
    tinyfishApiKey: undefined,
  };
  // 扁平本体先垫底，直挂 config / resolved.config 逐层覆盖。
  for (const key of Object.keys(merged)) {
    if (typeof flat[key] === 'string') merged[key] = flat[key];
  }
  for (const source of [fromConfig, fromResolved]) {
    if (source && typeof source === 'object') {
      for (const key of Object.keys(merged)) {
        if (typeof source[key] === 'string') merged[key] = source[key];
      }
    }
  }
  // 透传其余配置字段（端点地址、超时等）同样按 扁平 < config < resolved.config 合并。
  /** @type {Record<string, any>} */
  const extra = {};
  for (const source of [flat, fromConfig, fromResolved]) {
    if (source && typeof source === 'object') {
      for (const key of Object.keys(source)) {
        if (key === 'config' || key === 'resolved') continue;
        if (source[key] !== undefined) extra[key] = source[key];
      }
    }
  }
  return { ...extra, ...merged };
}

/**
 * 组装透传给供应商的依赖：拍平后的配置 + 原 deps 透传字段（如 fetchImpl）。
 * 供应商只认扁平密钥（deps.linkupApiKey），此处保证无论上游传哪种形态都能读到。
 * @param {any} deps 调用方注入的依赖
 * @param {Record<string, any>} toolConfig 归一化配置
 * @returns {any} 下游依赖
 */
function resolveProviderDeps(deps, toolConfig) {
  const base = deps && typeof deps === 'object' ? deps : {};
  return { ...base, ...toolConfig, config: toolConfig };
}
/**
 * 判断抛出的异常是否值得回退：纯标志判断，只有明确 retryable:false 才跳过。
 * 与 errors[] 条目规则一致；无标志的凭证类错误同样尝试回退（回退方可能有可用 Key/额度）。
 * @param {any} error 捕获的异常
 * @returns {boolean} 是否可重试
 */
function isRetryableThrown(error) {
  if (error && typeof error === 'object' && error.retryable === false) return false;
  return true;
}

/**
 * 判断抓取错误是否值得重试（缺省可重试，只有明确 retryable:false 才跳过）。
 * @param {any} errItem UnifiedFetch errors 数组中的单项
 * @returns {boolean} 是否可重试
 */
function isRetryableError(errItem) {
  if (!errItem || typeof errItem !== 'object') return true;
  if (errItem.retryable === false) return false;
  return true;
}

/**
 * 归一化抓取供应商返回值，保证 {results, errors} 形状。
 * @param {any} value 供应商原始返回值
 * @returns {{results: Array<any>, errors: Array<any>}} 归一化结果
 */
function normalizeFetchResult(value) {
  const results = Array.isArray(value?.results) ? value.results : [];
  const errors = Array.isArray(value?.errors) ? value.errors : [];
  return { results, errors };
}

/**
 * 分发 MCP 工具调用。
 * - so_search：按归一化配置 searchProvider 取搜索供应商并调用。
 * - so_fetch：先调主抓取（fetchPrimary），errors 非空或抛错且可重试时用回退供应商补抓并置 fallbackUsed=true。
 * - so_verify：转调 verifyQuery（动态导入，避免与 lib/verify.js 静态循环依赖）。
 * @param {string} name 工具名
 * @param {any} args 工具参数
 * @param {ToolDeps} [deps] 调用方注入的依赖（端点 resolveDeps 产物或直挂 Config 均可）
 * @returns {Promise<any>} 工具执行结果（可 JSON 序列化）
 */
export async function dispatchTool(name, args, deps) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  // 归一化配置并拍平透传：供应商只认扁平密钥。
  const toolConfig = resolveToolConfig(deps);
  const providerDeps = resolveProviderDeps(deps, toolConfig);

  switch (name) {
    case 'so_search': {
      // 按 SEARCH_PROVIDER 选择搜索供应商，默认 linkup。
      const providerName = toolConfig.searchProvider || 'linkup';
      const searchFn = getSearchProvider(providerName);
      if (typeof searchFn !== 'function') {
        throw new Error(`未知搜索供应商: ${providerName}`);
      }
      return await searchFn(safeArgs, providerDeps);
    }

    case 'so_fetch': {
      // 校验 urls 形状：1..10 条。
      const urls = safeArgs.urls;
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > 10) {
        throw new Error('so_fetch 参数 urls 须为 1..10 条地址数组');
      }
      const primaryName = toolConfig.fetchPrimary || 'tinyfish';
      const fallbackName = toolConfig.fetchFallback || 'linkup';
      const primaryFn = getFetchProvider(primaryName);
      if (typeof primaryFn !== 'function') {
        throw new Error(`未知主抓取供应商: ${primaryName}`);
      }

      /** @type {{results: Array<any>, errors: Array<any>}} */
      let primaryResult;
      try {
        primaryResult = normalizeFetchResult(await primaryFn(safeArgs, providerDeps));
      } catch (primaryError) {
        // 主抓取抛错：仅明确 retryable:false 才直接上抛，其余（含无标志位）视为可重试走回退。
        if (!isRetryableThrown(primaryError)) throw primaryError;
        // 可重试抛错：把全部地址视为可重试失败，走回退补抓。
        primaryResult = {
          results: [],
          errors: urls.map((url) => ({
            url: String(url),
            error: primaryError instanceof Error ? primaryError.message : String(primaryError),
            retryable: true,
          })),
        };
      }

      // 主抓取全部成功：无需回退。
      if (primaryResult.errors.length === 0) {
        return {
          results: primaryResult.results,
          errors: [],
          fallbackUsed: false,
          providers: [primaryName],
        };
      }

      // 主副同名或无回退可用：直接返回主结果。
      if (!fallbackName || fallbackName === primaryName) {
        return {
          results: primaryResult.results,
          errors: primaryResult.errors,
          fallbackUsed: false,
          providers: [primaryName],
        };
      }

      // 仅对可重试的失败地址做回退补抓。
      const retryUrls = primaryResult.errors.filter(isRetryableError).map((item) => item.url);
      if (retryUrls.length === 0) {
        return {
          results: primaryResult.results,
          errors: primaryResult.errors,
          fallbackUsed: false,
          providers: [primaryName],
        };
      }

      const fallbackFn = getFetchProvider(fallbackName);
      if (typeof fallbackFn !== 'function') {
        throw new Error(`未知回退抓取供应商: ${fallbackName}`);
      }
      const fallbackParams = { ...safeArgs, urls: retryUrls };
      let fallbackResult;
      try {
        fallbackResult = normalizeFetchResult(await fallbackFn(fallbackParams, providerDeps));
      } catch (fallbackError) {
        // 回退整体抛错：保留主结果，错误合并为回退失败。
        return {
          results: primaryResult.results,
          errors: retryUrls.map((url) => ({
            url: String(url),
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            retryable: true,
          })),
          fallbackUsed: true,
          providers: [primaryName, fallbackName],
        };
      }
      // 保留主抓取中不可重试的失败，回退只结算可重试部分。
      const keptErrors = primaryResult.errors.filter((item) => !isRetryableError(item));
      return {
        results: [...primaryResult.results, ...fallbackResult.results],
        errors: [...keptErrors, ...fallbackResult.errors],
        fallbackUsed: true,
        providers: [primaryName, fallbackName],
      };
    }


    case 'so_verify': {
      // 动态导入打破 tools <-> verify 的静态循环依赖。
      const verifyModule = await import('./verify.js');
      return await verifyModule.verifyQuery(safeArgs, deps);
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}
