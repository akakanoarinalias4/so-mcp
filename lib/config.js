/**
 * 运行配置：环境变量解析与单次请求的依赖装配。
 *
 * 环境变量（全部在服务端读取，永不回传客户端、不打日志）：
 *   - PROXY_API_KEY      必填，客户端出示给本代理的凭证
 *   - LINKUP_API_KEY     可选，Linkup 搜索 / 抓取 / 余额的上游密钥
 *   - TINYFISH_API_KEY   可选，Tinyfish 抓取的上游密钥
 *   - SEARCH_PROVIDER    可选，默认 linkup
 *   - FETCH_PRIMARY      可选，默认 tinyfish
 *   - FETCH_FALLBACK     可选，默认 linkup
 *   - CREDITS_TIMEOUT_MS 可选，余额查询独立超时，默认 15000
 *
 * 上游地址均为固定常量，没有别的开关。
 */

import process from 'node:process';

/** Vercel Function 请求体上限 4.5 MB，代理在 4 MB 处直接拒绝。 */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** 余额查询默认独立超时（毫秒），远小于函数执行上限。 */
export const CREDITS_TIMEOUT_MS = 15_000;

/** Linkup 统一搜索地址。 */
const SEARCH_URL_LINKUP = 'https://api.linkup.so/v1/search';

/** Linkup 单条抓取地址（扇出适配多 URL）。 */
const FETCH_URL_LINKUP = 'https://api.linkup.so/v1/fetch';

/** Tinyfish 抓取主地址。 */
const FETCH_URL_TINYFISH = 'https://api.fetch.tinyfish.ai';

/** Linkup 余额查询地址。 */
const CREDITS_URL_LINKUP = 'https://api.linkup.so/v1/credits/balance';

const PROXY_API_KEY_ENV = 'PROXY_API_KEY';
const LINKUP_API_KEY_ENV = 'LINKUP_API_KEY';
const TINYFISH_API_KEY_ENV = 'TINYFISH_API_KEY';
const SEARCH_PROVIDER_ENV = 'SEARCH_PROVIDER';
const FETCH_PRIMARY_ENV = 'FETCH_PRIMARY';
const FETCH_FALLBACK_ENV = 'FETCH_FALLBACK';
const CREDITS_TIMEOUT_ENV = 'CREDITS_TIMEOUT_MS';

/**
 * 代理运行配置。
 *
 * @typedef {object} Config
 * @property {string} proxyApiKey      客户端必须出示的本代理密钥。
 * @property {string} linkupApiKey     注入 Linkup 上游的密钥（可为空）。
 * @property {string} tinyfishApiKey   注入 Tinyfish 上游的密钥（可为空）。
 * @property {string} searchProvider   搜索供应商名，默认 linkup。
 * @property {string} fetchPrimary     抓取主供应商名，默认 tinyfish。
 * @property {string} fetchFallback    抓取回退供应商名，默认 linkup。
 * @property {string} creditsUrlLinkup Linkup 余额查询地址。
 * @property {string} fetchUrlTinyfish Tinyfish 抓取地址。
 * @property {string} fetchUrlLinkup   Linkup 抓取地址。
 * @property {string} searchUrlLinkup  Linkup 搜索地址。
 * @property {number} creditsTimeoutMs 余额查询独立超时（毫秒）。
 */

/**
 * @typedef {object} ConfigResolution
 * @property {boolean} ok           部署配置是否完整。
 * @property {string[]} missing     缺失的环境变量名。
 * @property {Config} config        恒存在，处理器仍可据此应答。
 */

/**
 * 端点装配依赖的输入。
 *
 * @typedef {object} GatewayDeps
 * @property {Record<string, string | undefined>} [env] 环境变量袋（默认 process.env）。
 * @property {typeof fetch} [fetchImpl]                 抓取实现（测试注入用）。
 */

/**
 * 单次请求解析出的配置与抓取实现。
 *
 * @typedef {object} ResolvedDeps
 * @property {ConfigResolution} resolved
 * @property {typeof fetch} fetchImpl
 */

/**
 * 裁剪取值，空串视为缺失。
 *
 * @param {string | undefined | null} value
 * @returns {string | undefined}
 */
function trimmed(value) {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result === '' ? undefined : result;
}

/**
 * 解析正整数，非法时回退默认值。
 *
 * @param {string | undefined | null} value
 * @param {number} fallback
 * @returns {number}
 */
function intOr(value, fallback) {
  const text = trimmed(value);
  if (!text) return fallback;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * 按环境变量存在性动态组装余额供应商名单。
 * 有 LINKUP_API_KEY 即含 linkup，有 TINYFISH_API_KEY 即含 tinyfish，空串视为缺失。
 * 新增钱包只需在此加一行存在性判断，并同步注册余额函数。
 * @param {Record<string, string | undefined>} [env] 环境变量袋（默认 process.env）
 * @returns {string[]} 接入的余额供应商名列表
 */
export function resolveCreditsProviders(env = process.env) {
  /** @type {string[]} */
  const providers = [];
  if (trimmed(env[LINKUP_API_KEY_ENV])) providers.push('linkup');
  if (trimmed(env[TINYFISH_API_KEY_ENV])) providers.push('tinyfish');
  return providers;
}

/**
 * 从环境变量袋解析代理配置。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {ConfigResolution}
 */
export function resolveConfig(env = process.env) {
  /** @type {string[]} */
  const missing = [];

  const proxyApiKey = trimmed(env[PROXY_API_KEY_ENV]);
  if (!proxyApiKey) missing.push(PROXY_API_KEY_ENV);

  // 上游密钥按名单必填：名单为空时一次性记入两缺失键，名单非空不再记缺失。
  const linkupApiKey = trimmed(env[LINKUP_API_KEY_ENV]);
  const tinyfishApiKey = trimmed(env[TINYFISH_API_KEY_ENV]);
  if (!linkupApiKey && !tinyfishApiKey) missing.push(LINKUP_API_KEY_ENV, TINYFISH_API_KEY_ENV);
  const searchProvider = (trimmed(env[SEARCH_PROVIDER_ENV]) ?? 'linkup').toLowerCase();
  const fetchPrimary = (trimmed(env[FETCH_PRIMARY_ENV]) ?? 'tinyfish').toLowerCase();
  const fetchFallback = (trimmed(env[FETCH_FALLBACK_ENV]) ?? 'linkup').toLowerCase();

  return {
    ok: missing.length === 0,
    missing,
    config: {
      proxyApiKey: proxyApiKey ?? '',
      linkupApiKey: linkupApiKey ?? '',
      tinyfishApiKey: tinyfishApiKey ?? '',
      searchProvider,
      fetchPrimary,
      fetchFallback,
      creditsUrlLinkup: CREDITS_URL_LINKUP,
      fetchUrlTinyfish: FETCH_URL_TINYFISH,
      fetchUrlLinkup: FETCH_URL_LINKUP,
      searchUrlLinkup: SEARCH_URL_LINKUP,
      creditsTimeoutMs: intOr(env[CREDITS_TIMEOUT_ENV], CREDITS_TIMEOUT_MS),
    },
  };
}

/**
 * 解析单次请求的依赖：配置与抓取实现。
 *
 * @param {GatewayDeps} [input]
 * @returns {ResolvedDeps}
 */
export function resolveDeps(input) {
  return {
    resolved: resolveConfig(input?.env ?? process.env),
    fetchImpl: input?.fetchImpl ?? fetch,
  };
}

/**
 * 部署缺配时的人类可读说明（中文）。
 *
 * @param {string[]} missing
 * @returns {string}
 */
export function misconfigurationMessage(missing) {
  return (
    `代理未正确配置：请在 Vercel 项目环境变量中设置 ${missing.join('、')}，然后重新部署。` +
    'PROXY_API_KEY 是 MCP 客户端出示给本代理的凭证；' +
    'LINKUP_API_KEY / TINYFISH_API_KEY 只注入上游，永不暴露给客户端。'
  );
}
