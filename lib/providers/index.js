/**
 * 供应商注册表：搜索与抓取引擎的可扩展装配点。
 *
 * 约定：新增引擎只需在本文件注册表加一行（名 -> 实现函数），
 * 调用方经由 getSearchProvider/getFetchProvider 按名获取，无需改动上层。
 */

import { linkupSearch } from './search-linkup.js';
import { tinyfishFetch } from './fetch-tinyfish.js';
import { linkupFetch } from './fetch-linkup.js';
import { getLinkupBalance, getTinyfishWallet } from '../credits.js';

/**
 * 搜索供应商注册表。
 * @type {Record<string, Function>}
 */
export const SEARCH_REGISTRY = {
  linkup: linkupSearch,
};

/**
 * 抓取供应商注册表。
 * @type {Record<string, Function>}
 */
export const FETCH_REGISTRY = {
  tinyfish: tinyfishFetch,
  linkup: linkupFetch,
};

/**
 * 余额供应商注册表。
 * 新增钱包只需在此注册一行（名 -> 余额函数），余额端点按名单动态扇出，无需改动上层。
 * @type {Record<string, Function>}
 */
export const CREDITS_REGISTRY = {
  linkup: getLinkupBalance,
  tinyfish: getTinyfishWallet,
};

/**
 * 构造未知供应商错误。
 * @param {string} kind 类别（search/fetch）
 * @param {string} name 供应商名
 * @returns {Error & {code: string}} 结构化错误
 */
function unknownProvider(kind, name) {
  const err = /** @type {Error & {code: string}} */ (
    new Error('未知' + kind + '供应商：' + name)
  );
  err.code = 'UNKNOWN_PROVIDER';
  return err;
}

/**
 * 按名获取搜索供应商实现。
 * @param {string} name 供应商名（如 linkup）
 * @returns {Function} 搜索函数 (params, deps) => Promise<UnifiedSearch>
 */
export function getSearchProvider(name) {
  const fn = SEARCH_REGISTRY[name];
  if (!fn) throw unknownProvider('搜索', String(name));
  return fn;
}

/**
 * 按名获取抓取供应商实现。
 * @param {string} name 供应商名（如 tinyfish、linkup）
 * @returns {Function} 抓取函数 (params, deps) => Promise<{results, errors}>
 */
export function getFetchProvider(name) {
  const fn = FETCH_REGISTRY[name];
  if (!fn) throw unknownProvider('抓取', String(name));
  return fn;
}
/**
 * 按名获取余额供应商实现。
 * 新增钱包只需在余额注册表加一行，调用方无需改动。
 * @param {string} name 供应商名（如 linkup、tinyfish）
 * @returns {Function} 余额函数 (deps) => Promise<余额状态>
 */
export function getCreditsProvider(name) {
  const fn = CREDITS_REGISTRY[name];
  if (!fn) throw unknownProvider('余额', String(name));
  return fn;
}

/**
 * 列出已注册的余额供应商名。
 * @returns {string[]} 余额供应商名列表
 */
export function listCreditsProviders() {
  return Object.keys(CREDITS_REGISTRY);
}

/**
 * 列出已注册的供应商名。
 * @returns {{search: string[], fetch: string[]}} 搜索与抓取的供应商名列表
 */
export function listProviders() {
  return {
    search: Object.keys(SEARCH_REGISTRY),
    fetch: Object.keys(FETCH_REGISTRY),
  };
}
