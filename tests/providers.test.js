/**
 * tests/providers.test.js
 * 供应商层单测：全部用桩 fetchImpl，不打真实网络。
 * 覆盖搜索映射、抓取 retryable 标记、单条扇出、缺键抛码、回退链、余额端点鉴权、动态钱包单双空三态。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkupSearch } from '../lib/providers/search-linkup.js';
import { tinyfishFetch } from '../lib/providers/fetch-tinyfish.js';
import { linkupFetch } from '../lib/providers/fetch-linkup.js';
import { getLinkupBalance, getTinyfishWallet } from '../lib/credits.js';
import { dispatchTool } from '../lib/tools.js';
import { handleCredits } from '../lib/endpoints/credits.js';

/** Linkup 搜索地址片段（桩路由用）。 */
const SEARCH_MARK = '/v1/search';
/** Tinyfish 抓取地址（与实现默认值对齐）。 */
const TINYFISH_FETCH_URL = 'https://api.fetch.tinyfish.ai';
/** Tinyfish 钱包地址（与实现默认值对齐，钱包与智能体同宿主，与抓取宿主分离）。 */
const TINYFISH_WALLET_URL = 'https://agent.tinyfish.ai/v1/wallet';
/** 回退成功的目标地址。 */
const GOOD_URL = 'https://case.local/good';
/** 回退失败的目标地址。 */
const BAD_URL = 'https://case.local/bad';
/** 余额端点冒烟用的代理密钥（只活在单测进程）。 */
const PROXY_KEY = 'test-proxy-key';

/**
 * 构造桩 Response（只实现调用方用到的 ok/status/json）。
 * @param {unknown} data 响应 JSON 负载
 * @param {number} [status] HTTP 状态码
 * @returns {{ok: boolean, status: number, json: () => Promise<unknown>}} 桩响应
 */
function stubResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

/**
 * 搜索桩：返回两种字段形态的结果，断言映射用。
 * @param {string} url 请求地址
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<unknown>}>} 桩响应
 */
async function searchStub(url) {
  assert.match(String(url), /\/v1\/search/);
  return stubResponse({
    results: [
      { name: '标题甲', url: 'https://case.local/1', content: '正文甲' },
      { title: '标题乙', link: 'https://case.local/2', snippet: '正文乙' },
    ],
  });
}

/** 搜索映射：name/url/content 与 title/link/snippet 都归一为 title/url/content。 */
describe('linkupSearch 映射', () => {
  it('两种字段形态都归一', async () => {
    const out = await linkupSearch({ query: '单测' }, {
      linkupApiKey: 'test-key',
      fetchImpl: searchStub,
    });
    assert.equal(out.provider, 'linkup');
    assert.equal(out.results.length, 2);
    assert.deepEqual(
      { title: out.results[0].title, url: out.results[0].url, content: out.results[0].content },
      { title: '标题甲', url: 'https://case.local/1', content: '正文甲' },
    );
    assert.deepEqual(
      { title: out.results[1].title, url: out.results[1].url, content: out.results[1].content },
      { title: '标题乙', url: 'https://case.local/2', content: '正文乙' },
    );
  });
});

/** 抓取包内错误：timeout 可重试、page_not_found 不可重试。 */
describe('tinyfishFetch 错误标记', () => {
  it('retryable 按枚举标记', async () => {
    /** @type {(url: string) => Promise<any>} 固定包内错误的桩 */
    const mixedStub = async () => stubResponse({
      results: [],
      errors: [
        { url: 'https://case.local/1', error: 'timeout' },
        { url: 'https://case.local/2', error: 'page_not_found' },
      ],
    });
    const out = await tinyfishFetch({ urls: ['https://case.local/1', 'https://case.local/2'] }, {
      tinyfishApiKey: 'test-key',
      fetchImpl: mixedStub,
    });
    assert.equal(out.errors.length, 2);
    assert.equal(out.errors[0].retryable, true);
    assert.equal(out.errors[1].retryable, false);
  });
});

/** 单条扇出：成功地址进 results，404 地址进 errors 且不可重试。 */
describe('linkupFetch 单条扇出', () => {
  it('逐地址结算互不干扰', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 按目标地址分流的桩 */
    const fanoutStub = async (url, init = {}) => {
      assert.ok(String(url).includes(SEARCH_MARK) === false);
      const target = JSON.parse(init.body || '{}').url;
      if (target === GOOD_URL) {
        return stubResponse({ url: target, title: '好标题', markdown: '好正文' });
      }
      return stubResponse({ message: 'not found' }, 404);
    };
    const out = await linkupFetch({ urls: [GOOD_URL, BAD_URL] }, {
      linkupApiKey: 'test-key',
      fetchImpl: fanoutStub,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.results[0].content, '好正文');
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].url, BAD_URL);
    assert.equal(out.errors[0].retryable, false);
  });
});

/** 缺 Key：直接抛 CREDENTIAL_MISSING，不触碰网络。 */
describe('getLinkupBalance 缺 Key', () => {
  it('抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      getLinkupBalance({ fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });
});

/** 钱包默认宿主：钱包与智能体同宿主，缺键抛码、鉴权四态不断言旧抓取宿主。 */
describe('getTinyfishWallet 默认钱包宿主', () => {
  it('缺 Key 抛 CREDENTIAL_MISSING', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的桩 */
    const neverStub = async () => {
      throw new Error('缺 Key 时不应发起请求');
    };
    await assert.rejects(
      getTinyfishWallet({ fetchImpl: neverStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
    );
  });

  it('默认请求智能体侧钱包地址', async () => {
    /** @type {string[]} 收到的请求地址 */
    const seen = [];
    /** @type {(url: string) => Promise<any>} 记录地址的桩 */
    const recordStub = async (url) => {
      seen.push(String(url));
      return stubResponse({ wallet: { credits: 1 } });
    };
    const out = await getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: recordStub });
    assert.equal(out.provider, 'tinyfish');
    assert.equal(seen.length, 1);
    assert.equal(seen[0], TINYFISH_WALLET_URL);
  });

  it('鉴权四态：401/403 抛 CREDENTIAL_MISSING，其余非 2xx 抛 UPSTREAM_ERROR', async () => {
    for (const status of [401, 403]) {
      /** @type {(url: string) => Promise<any>} 固定鉴权失败的桩 */
      const authStub = async () => stubResponse({ message: 'unauthorized' }, status);
      await assert.rejects(
        getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: authStub }),
        (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'CREDENTIAL_MISSING',
      );
    }
    /** @type {(url: string) => Promise<any>} 固定服务端异常的桩 */
    const errorStub = async () => stubResponse({ message: 'boom' }, 500);
    await assert.rejects(
      getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: errorStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'UPSTREAM_ERROR',
    );
    /** @type {(url: string) => Promise<any>} 固定超时的桩 */
    const timeoutStub = async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    };
    await assert.rejects(
      getTinyfishWallet({ tinyfishApiKey: 'test-key', fetchImpl: timeoutStub }),
      (/** @type {any} */ error) => (/** @type {any} */ (error)).code === 'UPSTREAM_TIMEOUT',
    );
  });
});

/** 回退链：主供应商可重试失败后，回退补抓成功并置 fallbackUsed。 */
describe('dispatchTool 回退链', () => {
  it('主失败走回退且标记 fallbackUsed', async () => {
    /** @type {(url: string, init?: any) => Promise<any>} 主次分流的桩 */
    const fallbackStub = async (url, init = {}) => {
      const text = String(url);
      if (text === TINYFISH_FETCH_URL) {
        const asked = JSON.parse(init.body || '{}').urls;
        return stubResponse({
          results: [],
          errors: asked.map((/** @type {any} */ item) => ({ url: item, error: 'timeout' })),
        });
      }
      const target = JSON.parse(init.body || '{}').url;
      return stubResponse({ url: target, title: '回退标题', markdown: '回退正文' });
    };
    const out = await dispatchTool('so_fetch', { urls: [GOOD_URL] }, /** @type {any} */ ({
      fetchPrimary: 'tinyfish',
      fetchFallback: 'linkup',
      tinyfishApiKey: 'test-key',
      linkupApiKey: 'test-key',
      fetchImpl: fallbackStub,
    }));
    assert.equal(out.fallbackUsed, true);
    assert.deepEqual(out.providers, ['tinyfish', 'linkup']);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, GOOD_URL);
    assert.equal(out.errors.length, 0);
  });
});

/** 余额端点鉴权：独立 /credits 端点无令牌、错令牌与旧出示方式均回 401 未授权。 */
describe('handleCredits 余额端点鉴权', () => {
  it('无代理密钥回缺密钥', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('未授权时不应触碰上游');
    };
    const request = new Request('https://case.local/credits');
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, LINKUP_API_KEY: 'test-linkup-key', TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'missing_api_key');
  });

  it('错持有者令牌回无效密钥', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('未授权时不应触碰上游');
    };
    const request = new Request('https://case.local/credits', {
      headers: { authorization: 'Bearer wrong-key' },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, LINKUP_API_KEY: 'test-linkup-key', TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'invalid_api_key');
  });

  it('旧自定义头带正确值仍回缺密钥', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('未授权时不应触碰上游');
    };
    const request = new Request('https://case.local/credits', {
      headers: { 'x-api-key': PROXY_KEY },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, LINKUP_API_KEY: 'test-linkup-key', TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'missing_api_key');
  });

  it('旧查询参数带正确值仍回缺密钥', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('未授权时不应触碰上游');
    };
    const request = new Request(`https://case.local/credits?apiKey=${PROXY_KEY}`);
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, LINKUP_API_KEY: 'test-linkup-key', TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'missing_api_key');
  });
});

/** 动态钱包：余额 data 按接入名单动态组装，有几家回几家，空名单回 500 代理未配置。 */
describe('handleCredits 动态钱包', () => {
  it('单 linkup 只回 linkup 键', async () => {
    /** @type {(url: string) => Promise<any>} 只服务 Linkup 余额地址的桩 */
    const linkupOnlyStub = async (url) => {
      assert.match(String(url), /credits\/balance/);
      return stubResponse({ balance: 1234 });
    };
    const request = new Request('https://case.local/credits', {
      headers: { authorization: 'Bearer ' + PROXY_KEY },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, LINKUP_API_KEY: 'test-linkup-key' }, fetchImpl: linkupOnlyStub },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body?.data?.linkup?.provider, 'linkup');
    assert.equal(body?.data?.linkup?.balance, 1234);
    assert.equal('tinyfish' in (body?.data ?? {}), false);
  });

  it('单 tinyfish 只回 tinyfish 键', async () => {
    /** @type {(url: string) => Promise<any>} 只服务 Tinyfish 钱包地址的桩 */
    const tinyfishOnlyStub = async (url) => {
      assert.match(String(url), /agent\.tinyfish\.ai\/v1\/wallet/);
      return stubResponse({ wallet: { credits: 5678 } });
    };
    const request = new Request('https://case.local/credits', {
      headers: { authorization: 'Bearer ' + PROXY_KEY },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY, TINYFISH_API_KEY: 'test-tinyfish-key' }, fetchImpl: tinyfishOnlyStub },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body?.data?.tinyfish?.provider, 'tinyfish');
    assert.equal('linkup' in (body?.data ?? {}), false);
  });

  it('空名单回 500 代理未配置', async () => {
    /** @type {(url: string) => Promise<any>} 不应被调用的上游桩 */
    const neverStub = async () => {
      throw new Error('空名单时不应触碰上游');
    };
    const request = new Request('https://case.local/credits', {
      headers: { authorization: 'Bearer ' + PROXY_KEY },
    });
    const response = await handleCredits(
      request,
      { env: { PROXY_API_KEY: PROXY_KEY }, fetchImpl: neverStub },
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'proxy_misconfigured');
  });
});
