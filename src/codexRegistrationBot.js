/**
 * Codex (OpenAI/ChatGPT) 批量注册机器人
 * 基于纯 HTTP 协议实现，不依赖浏览器
 * 
 * 功能：
 * 1. 基于系统域名 + QQ IMAP 的邮箱验证
 * 2. ChatGPT 账号注册（含 OTP 验证）
 * 3. Codex OAuth Token 获取（PKCE 流程）
 * 4. Sentinel PoW Token 生成
 */

const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { URL, URLSearchParams } = require('url');

const CODEX_REG_RUNTIME_TAG = 'cfdiag-20260324-3';

// ================= Electron Chromium TLS 检测 =================
// Electron 的 net 模块使用 Chromium 的网络栈，TLS 指纹与真实 Chrome 一致
// 可以绕过 Cloudflare 的 JA3/JA4 TLS 指纹检测
let _electronNet = null;
let _electronSession = null;
try {
  const _electron = require('electron');
  if (_electron && _electron.net && _electron.session) {
    _electronNet = _electron.net;
    _electronSession = _electron.session;
  }
} catch {}

// 加载常量
function getConstants() {
  try {
    return require('../js/constants');
  } catch {
    return require('./constants');
  }
}

// ================= Chrome 指纹配置 =================
const CHROME_PROFILES = [
  {
    major: 131, build: 6778, patchRange: [69, 205],
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  },
  {
    major: 133, build: 6943, patchRange: [33, 153],
    secChUa: '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  },
  {
    major: 136, build: 7103, patchRange: [48, 175],
    secChUa: '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
  },
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randomDelay(low = 300, high = 1000) {
  return new Promise(resolve => setTimeout(resolve, randomInt(low, high)));
}

function randomChromeVersion() {
  const profile = CHROME_PROFILES[randomInt(0, CHROME_PROFILES.length - 1)];
  const patch = randomInt(...profile.patchRange);
  const fullVer = `${profile.major}.0.${profile.build}.${patch}`;
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVer} Safari/537.36`;
  return { major: profile.major, fullVer, ua, secChUa: profile.secChUa };
}

function generatePassword(length = 14) {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const special = '!@#$%&*';
  const all = lower + upper + digits + special;
  const pwd = [
    lower[randomInt(0, lower.length - 1)],
    upper[randomInt(0, upper.length - 1)],
    digits[randomInt(0, digits.length - 1)],
    special[randomInt(0, special.length - 1)],
  ];
  for (let i = 4; i < length; i++) {
    pwd.push(all[randomInt(0, all.length - 1)]);
  }
  // shuffle
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
  }
  return pwd.join('');
}

function randomName() {
  const firsts = ['James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Sophia',
    'Lucas', 'Mia', 'Mason', 'Isabella', 'Logan', 'Charlotte', 'Alexander',
    'Amelia', 'Benjamin', 'Harper', 'William', 'Evelyn'];
  const lasts = ['Smith', 'Johnson', 'Brown', 'Davis', 'Wilson', 'Moore', 'Taylor',
    'Clark', 'Hall', 'Young', 'Anderson', 'Thomas', 'Jackson', 'White',
    'Harris', 'Martin', 'Thompson', 'Garcia', 'Robinson', 'Lewis'];
  return `${firsts[randomInt(0, firsts.length - 1)]} ${lasts[randomInt(0, lasts.length - 1)]}`;
}

function randomBirthdate() {
  const y = randomInt(1985, 2002);
  const m = String(randomInt(1, 12)).padStart(2, '0');
  const d = String(randomInt(1, 28)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function generatePKCE() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { codeVerifier: verifier, codeChallenge: challenge };
}

function makeTraceHeaders() {
  const traceId = uuidv4().replace(/-/g, '');
  const parentId = crypto.randomBytes(8).toString('hex');
  return {
    'traceparent': `00-${traceId}-${parentId}-01`,
    'tracestate': 'dd=s:1;o:rum',
    'x-datadog-origin': 'rum',
    'x-datadog-sampling-priority': '1',
    'x-datadog-trace-id': String(BigInt('0x' + traceId.slice(0, 16))),
    'x-datadog-parent-id': String(BigInt('0x' + parentId)),
  };
}

function extractCodeFromUrl(url) {
  if (!url || !url.includes('code=')) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('code');
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return {};
    let payload = parts[1];
    // pad base64
    const pad = 4 - (payload.length % 4);
    if (pad !== 4) payload += '='.repeat(pad);
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// ================= Sentinel Token Generator (PoW) =================
class SentinelTokenGenerator {
  constructor(deviceId, userAgent) {
    this.deviceId = deviceId || uuidv4();
    this.userAgent = userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    this.requirementsSeed = String(Math.random());
    this.sid = uuidv4();
  }

  static fnv1a32(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= (h >>> 16);
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= (h >>> 13);
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= (h >>> 16);
    h >>>= 0;
    return h.toString(16).padStart(8, '0');
  }

  _getConfig() {
    const now = new Date();
    const nowStr = now.toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
    const perfNow = randomFloat(1000, 50000);
    const timeOrigin = Date.now() - perfNow;
    const navProps = ['vendorSub', 'productSub', 'vendor', 'maxTouchPoints',
      'scheduling', 'userActivation', 'doNotTrack', 'geolocation',
      'connection', 'plugins', 'mimeTypes', 'pdfViewerEnabled',
      'hardwareConcurrency', 'cookieEnabled', 'credentials',
      'mediaDevices', 'permissions', 'locks', 'ink'];
    const navProp = navProps[randomInt(0, navProps.length - 1)];

    return [
      '1920x1080',
      nowStr,
      4294705152,
      Math.random(),
      this.userAgent,
      'https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js',
      null,
      null,
      'en-US',
      'en-US,en',
      Math.random(),
      `${navProp}-undefined`,
      ['location', 'implementation', 'URL', 'documentURI', 'compatMode'][randomInt(0, 4)],
      ['Object', 'Function', 'Array', 'Number', 'parseFloat', 'undefined'][randomInt(0, 5)],
      perfNow,
      this.sid,
      '',
      [4, 8, 12, 16][randomInt(0, 3)],
      timeOrigin,
    ];
  }

  static _base64Encode(data) {
    const raw = JSON.stringify(data);
    return Buffer.from(raw, 'utf8').toString('base64');
  }

  _runCheck(startTime, seed, difficulty, config, nonce) {
    config[3] = nonce;
    config[9] = Math.round((Date.now() - startTime));
    const data = SentinelTokenGenerator._base64Encode(config);
    const hashHex = SentinelTokenGenerator.fnv1a32(seed + data);
    const diffLen = difficulty.length;
    if (hashHex.substring(0, diffLen) <= difficulty) {
      return data + '~S';
    }
    return null;
  }

  generateToken(seed, difficulty) {
    seed = seed !== undefined ? seed : this.requirementsSeed;
    difficulty = String(difficulty || '0');
    const startTime = Date.now();
    const config = this._getConfig();
    const MAX_ATTEMPTS = 500000;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const result = this._runCheck(startTime, seed, difficulty, config, i);
      if (result) {
        return 'gAAAAAB' + result;
      }
    }
    return 'gAAAAAB' + 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + SentinelTokenGenerator._base64Encode(String(null));
  }

  generateRequirementsToken() {
    const config = this._getConfig();
    config[3] = 1;
    config[9] = Math.round(randomFloat(5, 50));
    const data = SentinelTokenGenerator._base64Encode(config);
    return 'gAAAAAC' + data;
  }
}

// ================= Sentinel API =================
async function fetchSentinelChallenge(httpClient, deviceId, flow, userAgent, secChUa) {
  const generator = new SentinelTokenGenerator(deviceId, userAgent);
  const reqBody = {
    p: generator.generateRequirementsToken(),
    id: deviceId,
    flow: flow,
  };

  try {
    const resp = await httpClient.post('https://sentinel.openai.com/backend-api/sentinel/req', JSON.stringify(reqBody), {
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Referer': 'https://sentinel.openai.com/backend-api/sentinel/frame.html',
        'Origin': 'https://sentinel.openai.com',
        'User-Agent': userAgent,
        'sec-ch-ua': secChUa,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
      timeout: 20000,
    });
    return resp.data;
  } catch (e) {
    return null;
  }
}

async function buildSentinelToken(httpClient, deviceId, flow, userAgent, secChUa) {
  const challenge = await fetchSentinelChallenge(httpClient, deviceId, flow, userAgent, secChUa);
  if (!challenge) return null;

  const cValue = challenge.token || '';
  if (!cValue) return null;

  const powData = challenge.proofofwork || {};
  const generator = new SentinelTokenGenerator(deviceId, userAgent);

  let pValue;
  if (powData.required && powData.seed) {
    pValue = generator.generateToken(powData.seed, powData.difficulty || '0');
  } else {
    pValue = generator.generateRequirementsToken();
  }

  return JSON.stringify({
    p: pValue,
    t: '',
    c: cValue,
    id: deviceId,
    flow: flow,
  });
}

// ================= ChatGPT Register Class =================
class ChatGPTRegister {
  constructor(options = {}) {
    const CONSTANTS = getConstants();
    this.BASE = CONSTANTS.CODEX_CHATGPT_BASE;
    this.AUTH = CONSTANTS.CODEX_OAUTH_ISSUER;
    this.OAUTH_CLIENT_ID = CONSTANTS.CODEX_OAUTH_CLIENT_ID;
    this.OAUTH_REDIRECT_URI = CONSTANTS.CODEX_OAUTH_REDIRECT_URI;

    this.tag = options.tag || '';
    this.deviceId = uuidv4();
    this.authSessionLoggingId = uuidv4();
    this.cancelled = false;

    const chrome = randomChromeVersion();
    this.chromeMajor = chrome.major;
    this.chromeFullVer = chrome.fullVer;
    this.ua = chrome.ua;
    this.secChUa = chrome.secChUa;

    // Cookie jar (简易实现)
    this.cookies = {};

    // 保存代理地址（用于 Electron session 代理配置）
    this._proxyUrl = options.proxy || '';

    // 每个实例使用独立的 Electron session 分区（避免并发冲突）
    this._sessionPartition = `persist:codex-reg-${this.deviceId}`;

    // 配置 axios 实例
    const axiosConfig = {
      timeout: 30000,
      maxRedirects: 0, // 手动处理重定向
      validateStatus: () => true, // 不抛出 HTTP 错误
      headers: {
        'User-Agent': this.ua,
        'Accept-Language': ['en-US,en;q=0.9', 'en-US,en;q=0.9,zh-CN;q=0.8'][randomInt(0, 1)],
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'sec-ch-ua': this.secChUa,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-full-version': `"${this.chromeFullVer}"`,
        'sec-ch-ua-platform-version': `"${randomInt(10, 15)}.0.0"`,
      },
    };

    if (options.proxy) {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyUrl = options.proxy.includes('://') ? options.proxy : `http://${options.proxy}`;
      axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpAgent = new (require('http-proxy-agent').HttpProxyAgent)(proxyUrl);
      axiosConfig.proxy = false; // 使用自定义 agent，禁用 axios 内置代理
    }

    this.httpClient = axios.create(axiosConfig);

    // 请求/响应拦截器处理 Cookie
    this.httpClient.interceptors.request.use(config => {
      const cookieStr = this._getCookieString(config.url);
      if (cookieStr) {
        config.headers['Cookie'] = cookieStr;
      }
      return config;
    });

    this.httpClient.interceptors.response.use(response => {
      this._parseCookies(response);
      return response;
    });

    this.cookies['chatgpt.com'] = { 'oai-did': this.deviceId };
    this.cookies['auth.openai.com'] = { 'oai-did': this.deviceId };

    this._callbackUrl = null;
    this._logCallback = options.logCallback || null;
    this._emailConfig = options.emailConfig || null;   // { user, password, host, port }
    this._emailDomains = options.emailDomains || [];   // ['domain1.com', 'domain2.com']
    this._electronSessionReady = false;
  }

  _shouldLogChromeTlsDiag(url) {
    return typeof url === 'string'
      && (url.includes('/api/auth/csrf') || url.includes('/api/auth/signin/openai'));
  }

  _maskHeaderValue(key, value) {
    const lowerKey = String(key || '').toLowerCase();
    if (['cookie', 'authorization'].includes(lowerKey)) return '<redacted>';
    const str = String(value ?? '');
    return str.length > 160 ? `${str.slice(0, 157)}...` : str;
  }

  _isOpenAIAuthUrl(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname === 'auth.openai.com' || hostname.endsWith('.auth.openai.com');
    } catch {
      return false;
    }
  }

  _isChatGPTUrl(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com');
    } catch {
      return false;
    }
  }

  async _requestWithPreferredTransport(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    const preferChromeTls = !!options.preferChromeTls;
    const data = options.data;

    let body = null;
    if (typeof data !== 'undefined' && data !== null) {
      body = typeof data === 'string' ? data : JSON.stringify(data);
    }

    if (preferChromeTls) {
      const chromeResp = await this._fetchWithChromeTLSRetry(url, { method, headers, body });
      if (chromeResp) return chromeResp;
    }

    if (method === 'GET') {
      const resp = await this.httpClient.get(url, {
        headers,
        maxRedirects: options.maxRedirects ?? 0,
        timeout: options.timeout,
      });
      return { ...resp, url, headers: resp.headers || {} };
    }

    const resp = await this.httpClient.request({
      url,
      method,
      headers,
      data,
      maxRedirects: options.maxRedirects ?? 0,
      timeout: options.timeout,
    });
    return { ...resp, url, headers: resp.headers || {} };
  }

  async _buildSentinelTokenForFlow(flow) {
    return buildSentinelToken(this.httpClient, this.deviceId, flow, this.ua, this.secChUa);
  }

  _buildOpenAIJsonHeaders(referer, extraHeaders = {}) {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': this.AUTH,
      'Referer': referer,
      'User-Agent': this.ua,
      'oai-device-id': this.deviceId,
      ...makeTraceHeaders(),
      ...extraHeaders,
    };
  }

  _normalizeAuthContinueUrl(url) {
    if (!url) return '';
    if (typeof url !== 'string') return '';
    if (url.startsWith('/')) return `${this.AUTH}${url}`;
    return url;
  }

  _pageTypeToReferer(pageType, continueUrl, fallbackReferer = '') {
    const absoluteContinueUrl = this._normalizeAuthContinueUrl(continueUrl);
    if (absoluteContinueUrl && !absoluteContinueUrl.includes('/api/')) {
      return absoluteContinueUrl;
    }

    switch (pageType) {
      case 'login_or_signup_start':
        return `${this.AUTH}/log-in-or-create-account`;
      case 'create_account_start':
        return `${this.AUTH}/create-account`;
      case 'create_account_password':
        return `${this.AUTH}/create-account/password`;
      case 'login_password':
        return `${this.AUTH}/log-in/password`;
      case 'email_otp_verification':
      case 'email_otp_send':
        return `${this.AUTH}/email-verification`;
      case 'about_you':
        return `${this.AUTH}/about-you`;
      default:
        return fallbackReferer || absoluteContinueUrl || `${this.AUTH}/log-in-or-create-account`;
    }
  }

  _extractAuthFlowState(resp, fallbackReferer = '') {
    const data = (resp && resp.data) || {};
    const pageType = (data.page || {}).type || '';
    const continueUrl = this._normalizeAuthContinueUrl(
      data.continue_url || data.redirect_url || data.url || ''
    );
    const referer = this._pageTypeToReferer(pageType, continueUrl, fallbackReferer);
    return { pageType, continueUrl, referer };
  }

  _maybeStoreCallbackUrlFromData(data) {
    const callbackUrl = this._normalizeAuthContinueUrl(
      (data || {}).continue_url || (data || {}).redirect_url || (data || {}).url || ''
    );
    if (!callbackUrl) return;
    if (this._isChatGPTUrl(callbackUrl) || callbackUrl.includes('/api/auth/callback/')) {
      this._callbackUrl = callbackUrl;
    }
  }

  async _postOpenAIJson(path, { referer, data, flow, preferChromeTls = true }) {
    const extraHeaders = {};
    if (flow) {
      const sentinelToken = await this._buildSentinelTokenForFlow(flow);
      if (!sentinelToken) {
        return { status: 0, data: null, error: `${flow} sentinel token 获取失败` };
      }
      extraHeaders['openai-sentinel-token'] = sentinelToken;
    }

    const headers = this._buildOpenAIJsonHeaders(referer, extraHeaders);
    return this._requestWithPreferredTransport(`${this.AUTH}${path}`, {
      method: 'POST',
      headers,
      data,
      maxRedirects: 0,
      preferChromeTls,
    });
  }

  async _advanceUnifiedAuth(email, referer, screenHint = 'login_or_signup') {
    const sentinelAuthorize = await this._buildSentinelTokenForFlow('authorize_continue');
    if (!sentinelAuthorize) {
      return { status: 0, data: null, error: 'authorize_continue sentinel token 获取失败' };
    }

    const headers = this._buildOpenAIJsonHeaders(referer, {
      'openai-sentinel-token': sentinelAuthorize,
    });

    const resp = await this._requestWithPreferredTransport(`${this.AUTH}/api/accounts/authorize/continue`, {
      method: 'POST',
      headers,
      data: {
        username: { kind: 'email', value: email },
        screen_hint: screenHint,
      },
      maxRedirects: 0,
      preferChromeTls: true,
    });

    return resp;
  }

  async _startUnifiedSignup(email, referer) {
    return this._advanceUnifiedAuth(email, referer, 'signup');
  }

  // ==================== Chromium TLS 绕过 Cloudflare ====================

  /**
   * 使用 Electron Chromium 网络栈发送请求（真实 Chrome TLS 指纹）
   * 使用 net.request() API（兼容 Electron 26+），而非 net.fetch（需 Electron 28+）
   * 当 axios 被 Cloudflare JA3/JA4 TLS 指纹检测拦截 (403) 时使用
   * @returns {Object|null} { status, data, url } 或 null（不在 Electron 环境）
   */
  async _fetchWithChromeTLS(url, options = {}) {
    if (!_electronNet || !_electronSession) return null;

    // 每个实例使用独立分区，避免并发注册时 session 冲突
    const ses = _electronSession.fromPartition(this._sessionPartition);

    // 首次使用时配置 Electron session
    if (!this._electronSessionReady) {
      // 配置代理
      if (this._proxyUrl) {
        const proxyUrl = this._proxyUrl.includes('://') ? this._proxyUrl : `http://${this._proxyUrl}`;
        try {
          await ses.setProxy({ proxyRules: proxyUrl });
          this._log(`[CF] Electron 代理已设置: ${proxyUrl}`);
        } catch (e) {
          this._log(`[CF] Electron 代理设置失败: ${e.message}`);
        }
      }
      // 设置 oai-did cookie
      try {
        await ses.cookies.set({ url: this.BASE, name: 'oai-did', value: this.deviceId });
        await ses.cookies.set({ url: 'https://auth.openai.com', name: 'oai-did', value: this.deviceId });
      } catch {}
      this._electronSessionReady = true;
    }

    const mergedHeaders = {
      'User-Agent': this.ua,
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': this.secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-full-version': `"${this.chromeFullVer}"`,
      'sec-ch-ua-platform-version': `"${randomInt(10, 15)}.0.0"`,
      ...(options.headers || {}),
    };

    const debugEnabled = this._shouldLogChromeTlsDiag(url);
    const requestMeta = {
      runtime: CODEX_REG_RUNTIME_TAG,
      file: __filename,
      method: options.method || 'GET',
      url,
      session: this._sessionPartition,
      proxy: this._proxyUrl || '',
      bodyLength: options.body ? Buffer.byteLength(String(options.body)) : 0,
      chromeFullVer: this.chromeFullVer,
      secChUa: this.secChUa,
      appliedHeaders: [],
      skippedHeaders: [],
    };

    return new Promise((resolve) => {
      try {
        const req = _electronNet.request({
          method: options.method || 'GET',
          url: url,
          session: ses,
          useSessionCookies: true,
          redirect: 'manual',
        });

        // Chromium 会自行生成 fetch metadata；手动覆盖会在部分请求上触发
        // net::ERR_INVALID_ARGUMENT（例如 /api/auth/csrf + sec-fetch-mode=cors）。
        const _skipHeaders = new Set([
          'accept-encoding',
          'connection',
          'host',
          'content-length',
          'cookie',
          'sec-fetch-dest',
          'sec-fetch-mode',
          'sec-fetch-site',
          'sec-fetch-user',
        ]);
        for (const [key, value] of Object.entries(mergedHeaders)) {
          if (_skipHeaders.has(key.toLowerCase())) {
            requestMeta.skippedHeaders.push(key);
            continue;
          }
          try {
            req.setHeader(key, String(value));
            requestMeta.appliedHeaders.push(`${key}=${this._maskHeaderValue(key, value)}`);
          } catch (headerErr) {
            this._log(`[CF] 设置 header "${key}" 失败: ${headerErr.message}`);
            if (debugEnabled) {
              this._log(`[CF][diag] setHeaderFail runtime=${requestMeta.runtime} url=${url} header=${key} value=${this._maskHeaderValue(key, value)}`);
            }
          }
        }

        if (debugEnabled) {
          this._log(
            `[CF][diag] runtime=${requestMeta.runtime} method=${requestMeta.method} url=${requestMeta.url} ` +
            `bodyLength=${requestMeta.bodyLength} chrome=${requestMeta.chromeFullVer} ` +
            `skipped=[${requestMeta.skippedHeaders.join(', ')}] applied=[${requestMeta.appliedHeaders.join(' | ')}]`
          );
        }

        req.on('response', (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', async () => {
            try {
              const body = Buffer.concat(chunks).toString('utf8');
              const contentType = (response.headers['content-type'] || '');
              let data;
              try {
                if (contentType.includes('json')) {
                  data = JSON.parse(body);
                } else {
                  data = body;
                }
              } catch {
                data = body;
              }

              // 同步 Cloudflare cookies 到 axios cookie jar
              await this._syncElectronCookies(ses);

              const finalUrl = response.headers['location'] || url;
              if (debugEnabled) {
                this._log(`[CF][diag] response runtime=${requestMeta.runtime} status=${response.statusCode} url=${finalUrl}`);
              }
              resolve({ status: response.statusCode, data, url: finalUrl, headers: response.headers || {} });
            } catch (parseErr) {
              this._log(`[CF] 响应解析失败: ${parseErr.message}`);
              resolve(null);
            }
          });
          response.on('error', (e) => {
            this._log(`[CF] 响应流错误: ${e.message}`);
            resolve(null);
          });
        });

        let redirectHandled = false;

        req.on('error', (e) => {
          if (redirectHandled && /redirect was cancelled/i.test(e.message)) return;
          this._log(`[CF] Chromium 请求异常: ${e.message}`);
          if (debugEnabled) {
            this._log(
              `[CF][diag] requestError runtime=${requestMeta.runtime} method=${requestMeta.method} ` +
              `url=${requestMeta.url} chrome=${requestMeta.chromeFullVer} secChUa=${requestMeta.secChUa} ` +
              `skipped=[${requestMeta.skippedHeaders.join(', ')}]`
            );
          }
          resolve(null);
        });

        req.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
          redirectHandled = true;
          const flatHeaders = {};
          if (responseHeaders) {
            for (const [key, values] of Object.entries(responseHeaders)) {
              flatHeaders[key.toLowerCase()] = Array.isArray(values) ? values[0] : values;
            }
          }
          flatHeaders['location'] = redirectUrl;
          this._syncElectronCookies(ses).catch(() => {});
          resolve({
            status: statusCode,
            data: null,
            url,
            headers: flatHeaders,
          });
        });

        if (options.body) {
          req.write(options.body);
        }
        req.end();
      } catch (e) {
        this._log(`[CF] 请求创建失败: ${e.message}`);
        resolve(null);
      }
    });
  }

  /**
   * Chrome TLS 请求 + 自动重试（最多 retries 次）
   */
  async _fetchWithChromeTLSRetry(url, options = {}, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      const result = await this._fetchWithChromeTLS(url, options);
      if (result) return result;
      if (i < retries) {
        this._log(`[CF] Chrome TLS 重试 (${i + 1}/${retries})...`);
        await randomDelay(500, 1500);
      }
    }
    return null;
  }

  /**
   * 从 Electron session 同步 cookies 到 axios cookie jar
   */
  async _syncElectronCookies(ses) {
    const domains = ['chatgpt.com', '.chatgpt.com', 'auth.openai.com', '.auth.openai.com'];
    for (const domain of domains) {
      try {
        const cookies = await ses.cookies.get({ domain });
        for (const c of cookies) {
          const cookieDomain = (c.domain || domain).replace(/^\./, '');
          if (!this.cookies[cookieDomain]) this.cookies[cookieDomain] = {};
          this.cookies[cookieDomain][c.name] = c.value;
        }
      } catch {}
    }
  }

  _getCookieString(url) {
    try {
      const hostname = new URL(url).hostname;
      const parts = [];
      for (const [domain, cookies] of Object.entries(this.cookies)) {
        if (hostname.includes(domain) || hostname.endsWith('.' + domain)) {
          for (const [name, value] of Object.entries(cookies)) {
            parts.push(`${name}=${value}`);
          }
        }
      }
      return parts.join('; ');
    } catch {
      return '';
    }
  }

  _parseCookies(response) {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
    let hostname;
    try {
      hostname = new URL(response.config.url).hostname;
    } catch {
      return;
    }

    for (const cookie of cookies) {
      const parts = cookie.split(';');
      const [nameVal] = parts;
      if (!nameVal) continue;
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx < 0) continue;
      const name = nameVal.substring(0, eqIdx).trim();
      const value = nameVal.substring(eqIdx + 1).trim();

      // 提取 domain
      let domain = hostname;
      for (const part of parts.slice(1)) {
        const kv = part.trim().toLowerCase();
        if (kv.startsWith('domain=')) {
          domain = kv.substring(7).replace(/^\./, '');
          break;
        }
      }

      if (!this.cookies[domain]) this.cookies[domain] = {};
      this.cookies[domain][name] = value;
    }
  }

  _log(msg) {
    const prefix = this.tag ? `[${this.tag}] ` : '';
    const fullMsg = `${prefix}${msg}`;
    console.log(fullMsg);
    if (this._logCallback) this._logCallback(fullMsg);
  }

  _checkCancelled() {
    if (this.cancelled) throw new Error('用户取消操作');
  }

  // 手动跟随重定向
  async _followRedirects(url, headers, maxHops = 10) {
    let currentUrl = url;
    for (let i = 0; i < maxHops; i++) {
      this._checkCancelled();
      const resp = await this._requestWithPreferredTransport(currentUrl, {
        method: 'GET',
        headers,
        maxRedirects: 0,
        preferChromeTls: this._isOpenAIAuthUrl(currentUrl),
      });
      
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        let location = (resp.headers || {})['location'] || '';
        if (location.startsWith('/')) {
          const base = new URL(currentUrl);
          location = `${base.protocol}//${base.host}${location}`;
        }
        currentUrl = location;
        continue;
      }
      
      return { ...resp, url: currentUrl };
    }
    return { status: 0, url: currentUrl, data: null };
  }

  // ==================== 邮箱生成 & IMAP 验证码 ====================

  createTempEmail() {
    if (!this._emailDomains || this._emailDomains.length === 0) {
      throw new Error('未配置邮箱域名，请在「系统设置」中添加域名');
    }
    if (!this._emailConfig || !this._emailConfig.user || !this._emailConfig.password) {
      throw new Error('未配置 IMAP 邮箱，请在「系统设置」中配置邮箱');
    }

    // 随机选一个域名
    const domain = this._emailDomains[randomInt(0, this._emailDomains.length - 1)];

    // 生成 8-13 位随机用户名
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const length = randomInt(8, 13);
    let emailLocal = '';
    for (let i = 0; i < length; i++) {
      emailLocal += chars[randomInt(0, chars.length - 1)];
    }

    const email = `${emailLocal}@${domain}`;
    const chatgptPassword = generatePassword();

    this._log(`[邮箱] 生成: ${email} (域名 Catch-All → QQ IMAP)`);
    return { email, password: chatgptPassword };
  }

  async waitForVerificationEmail(targetEmail, timeout = 120000, notBefore = null) {
    this._log(`[OTP] 通过 IMAP 等待验证码 (目标: ${targetEmail}, 最多 ${timeout / 1000}s${notBefore ? `, 仅接受 ${new Date(notBefore).toISOString()} 之后的邮件` : ''})...`);
    const emailReceiverPath = require.resolve('./emailReceiver');
    delete require.cache[emailReceiverPath];
    const EmailReceiver = require(emailReceiverPath);
    const emailConfig = { ...this._emailConfig };
    if (notBefore) {
      emailConfig.notBefore = notBefore;
    }
    const receiver = new EmailReceiver(
      emailConfig,
      (msg) => this._log(`[IMAP] ${msg}`)
    );
    try {
      const code = await receiver.getVerificationCode(targetEmail, timeout);
      if (code) {
        this._log(`[OTP] 验证码: ${code}`);
      } else {
        this._log(`[OTP] 超时未收到验证码`);
      }
      return code;
    } catch (err) {
      this._log(`[OTP] IMAP 获取失败: ${err.message}`);
      return null;
    }
  }

  _extractVerificationCode(content) {
    if (!content) return null;
    const patterns = [
      /Verification code:?\s*(\d{6})/i,
      /code is\s*(\d{6})/i,
      />\s*(\d{6})\s*</,
      /(?<![#&])\b(\d{6})\b/,
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1] !== '177010') {
        return match[1];
      }
    }
    return null;
  }

  // ==================== 注册流程 ====================

  async visitHomepage() {
    const url = `${this.BASE}/`;
    const browserHeaders = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Cache-Control': 'max-age=0',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
    };

    // 优先使用 Chromium TLS + 自动重试（绕过 Cloudflare JA3/JA4 TLS 指纹检测）
    const chromeResp = await this._fetchWithChromeTLSRetry(url, { headers: browserHeaders });
    if (chromeResp && chromeResp.status !== 403) {
      this._log(`[注册] 0. 访问主页 -> ${chromeResp.status} (Chrome TLS)`);
      return;
    }

    // 回退到 axios（带增强浏览器头）
    const resp = await this._followRedirects(url, browserHeaders);
    this._log(`[注册] 0. 访问主页 -> ${resp.status}`);
    if (resp.status === 403) {
      this._log('[注册] ⚠ Cloudflare 拦截 (403)，TLS 指纹不匹配或 IP 被阻止，建议配置代理');
    }
  }

  async getCsrf() {
    const url = `${this.BASE}/api/auth/csrf`;
    const csrfHeaders = {
      'Accept': 'application/json',
      'Referer': `${this.BASE}/`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };

    // 优先使用 Chromium TLS + 自动重试
    const chromeResp = await this._fetchWithChromeTLSRetry(url, { headers: csrfHeaders });
    if (chromeResp && chromeResp.status === 200) {
      const token = typeof chromeResp.data === 'object' ? chromeResp.data?.csrfToken : null;
      this._log(`[注册] 1. 获取CSRF -> ${chromeResp.status} (Chrome TLS)`);
      if (!token) throw new Error('获取 CSRF token 失败');
      return token;
    }

    // 回退到 axios
    const resp = await this.httpClient.get(url, { headers: csrfHeaders });
    const token = resp.data?.csrfToken;
    this._log(`[注册] 1. 获取CSRF -> ${resp.status}`);
    if (!token) {
      if (resp.status === 403) {
        throw new Error('获取 CSRF token 失败 (Cloudflare 403，请配置代理后重试)');
      }
      throw new Error('获取 CSRF token 失败');
    }
    return token;
  }

  async signin(email, csrf) {
    const params = new URLSearchParams({
      prompt: 'login',
      'ext-oai-did': this.deviceId,
      auth_session_logging_id: this.authSessionLoggingId,
      screen_hint: 'login_or_signup',
      login_hint: email,
    });
    const url = `${this.BASE}/api/auth/signin/openai?${params}`;
    const formData = new URLSearchParams({
      callbackUrl: `${this.BASE}/`,
      csrfToken: csrf,
      json: 'true',
    });
    const signinHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Referer': `${this.BASE}/`,
      'Origin': this.BASE,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };

    // 优先使用 Chromium TLS + 自动重试（chatgpt.com 同域请求，需 Chrome 指纹）
    const chromeResp = await this._fetchWithChromeTLSRetry(url, {
      method: 'POST',
      headers: signinHeaders,
      body: formData.toString(),
    });
    if (chromeResp && chromeResp.status === 200) {
      const authorizeUrl = typeof chromeResp.data === 'object' ? chromeResp.data?.url : null;
      this._log(`[注册] 2. Signin -> ${chromeResp.status} (Chrome TLS)`);
      if (!authorizeUrl) throw new Error('获取 authorize URL 失败');
      return authorizeUrl;
    }

    // 回退到 axios
    const resp = await this.httpClient.post(url, formData.toString(), { headers: signinHeaders });
    const authorizeUrl = resp.data?.url;
    this._log(`[注册] 2. Signin -> ${resp.status}`);
    if (!authorizeUrl) throw new Error('获取 authorize URL 失败');
    return authorizeUrl;
  }

  async authorize(url) {
    const resp = await this._followRedirects(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': `${this.BASE}/`,
      'Upgrade-Insecure-Requests': '1',
    });
    this._log(`[注册] 3. Authorize -> ${resp.status} -> ${resp.url}`);
    return resp.url;
  }

  async register(email, password, referer = `${this.AUTH}/create-account/password`) {
    const resp = await this._postOpenAIJson('/api/accounts/user/register', {
      referer,
      data: { username: email, password },
    });
    this._log(`[注册] 4. Register -> ${resp.status}`);
    this._maybeStoreCallbackUrlFromData(resp.data);
    return { status: resp.status, data: resp.data };
  }

  async sendOtp(referer = `${this.AUTH}/create-account/password`) {
    const url = `${this.AUTH}/api/accounts/email-otp/send`;
    const resp = await this._followRedirects(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': referer,
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': this.ua,
    });
    this._log(`[注册] 5. Send OTP -> ${resp.status}`);
    return { status: resp.status, data: resp.data };
  }

  async resendOtp(referer = `${this.AUTH}/email-verification`) {
    const resp = await this._postOpenAIJson('/api/accounts/email-otp/resend', {
      referer,
      data: {},
    });
    this._log(`[注册] 5. Resend OTP -> ${resp.status}`);
    return { status: resp.status, data: resp.data };
  }

  async validateOtp(code, referer = `${this.AUTH}/email-verification`) {
    const resp = await this._postOpenAIJson('/api/accounts/email-otp/validate', {
      referer,
      data: { code },
    });
    this._log(`[注册] 6. Validate OTP -> ${resp.status}`);
    this._maybeStoreCallbackUrlFromData(resp.data);
    return { status: resp.status, data: resp.data };
  }

  async createAccount(name, birthdate, referer = `${this.AUTH}/about-you`) {
    const resp = await this._postOpenAIJson('/api/accounts/create_account', {
      referer,
      data: { name, birthdate },
      flow: 'authorize_continue',
    });
    this._log(`[注册] 7. Create Account -> ${resp.status}`);
    if (resp.data) {
      const cb = resp.data.continue_url || resp.data.url || resp.data.redirect_url;
      if (cb) this._callbackUrl = this._normalizeAuthContinueUrl(cb);
    }
    return { status: resp.status, data: resp.data };
  }

  async callback(url) {
    url = url || this._callbackUrl;
    if (!url) {
      this._log('[注册] 无回调 URL，跳过');
      return;
    }
    const resp = await this._followRedirects(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    });
    this._log(`[注册] 8. Callback -> ${resp.status}`);
  }

  // ==================== 注册主流程 ====================

  async runRegister(email, password, name, birthdate) {
    // 诊断信息
    const hasChromeTLS = !!(_electronNet && _electronSession);
    this._log(`[注册] Chrome TLS: ${hasChromeTLS ? '可用 (net.request)' : '不可用'} | 代理: ${this._proxyUrl || '未设置'} | Session: ${this._sessionPartition}`);
    this._log(`[注册][诊断] runtime=${CODEX_REG_RUNTIME_TAG} file=${__filename} chrome=${this.chromeFullVer} secChUa=${this.secChUa}`);

    this._checkCancelled();
    await this.visitHomepage();
    await randomDelay(300, 800);

    this._checkCancelled();
    const csrf = await this.getCsrf();
    await randomDelay(200, 500);

    this._checkCancelled();
    const authUrl = await this.signin(email, csrf);
    await randomDelay(300, 800);

    this._checkCancelled();
    const finalUrl = await this.authorize(authUrl);
    const finalParsedUrl = new URL(finalUrl);
    const finalPath = finalParsedUrl.pathname;
    const finalHost = finalParsedUrl.hostname;
    await randomDelay(300, 800);

    this._log(`[注册] Authorize -> ${finalHost}${finalPath}`);

    const authState = {
      pageType: '',
      continueUrl: '',
      referer: this._isOpenAIAuthUrl(finalUrl) ? finalUrl : '',
    };

    const syncAuthState = (stage, resp, fallbackReferer = authState.referer || finalUrl) => {
      const next = this._extractAuthFlowState(resp, fallbackReferer);
      if (next.pageType) authState.pageType = next.pageType;
      if (next.continueUrl) authState.continueUrl = next.continueUrl;
      authState.referer = next.referer || fallbackReferer || authState.referer;
      this._maybeStoreCallbackUrlFromData((resp || {}).data);
      this._log(
        `[注册][诊断] ${stage} status=${(resp || {}).status ?? '-'} page=${authState.pageType || '-'} ` +
        `next=${(authState.continueUrl || '-').substring(0, 140)}`
      );
      return authState;
    };

    const markAuthState = (pageType, referer = finalUrl, continueUrl = '') => {
      authState.pageType = pageType;
      authState.referer = referer;
      authState.continueUrl = this._normalizeAuthContinueUrl(continueUrl);
    };

    const isOtpStage = () => (
      authState.pageType === 'email_otp_verification' ||
      authState.pageType === 'email_otp_send' ||
      (authState.continueUrl && (
        authState.continueUrl.includes('email-verification') ||
        authState.continueUrl.includes('email-otp')
      ))
    );

    let needOtp = false;

    if (finalPath.includes('create-account/password')) {
      this._log('[注册] 全新注册流程');
      markAuthState('create_account_password', finalUrl);
    } else if (finalPath.includes('email-verification') || finalPath.includes('email-otp')) {
      this._log('[注册] 跳到 OTP 验证阶段');
      markAuthState('email_otp_verification', finalUrl);
    } else if (finalPath.includes('about-you')) {
      this._log('[注册] 跳到填写信息阶段');
      markAuthState('about_you', finalUrl);
    } else if (finalPath.includes('callback') || this._isChatGPTUrl(finalUrl)) {
      this._log('[注册] 账号已完成注册');
      return true;
    } else if (this._isOpenAIAuthUrl(finalUrl) && finalPath.includes('/api/accounts/authorize')) {
      this._log('[注册] 命中统一登录/注册入口，切换到 signup 流程');
      const unifiedResp = await this._startUnifiedSignup(email, finalUrl);
      syncAuthState('signup-start', unifiedResp, finalUrl);

      if (unifiedResp.status !== 200) {
        throw new Error(`统一注册流程推进失败 (${unifiedResp.status})`);
      }

      if (authState.pageType === 'login_password') {
        throw new Error('当前被服务端路由到登录密码页，而不是注册页；服务端尚未进入可发送邮箱验证码的 signup 状态');
      }
    } else {
      this._log(`[注册] 未知跳转: ${finalUrl}`);
      throw new Error(`未识别的注册跳转: ${finalUrl}`);
    }

    if (authState.pageType === 'create_account_password') {
      await randomDelay(500, 1000);
      const registerResp = await this.register(email, password, authState.referer);
      syncAuthState('register', registerResp, authState.referer);
      if (registerResp.status !== 200) {
        throw new Error(`Register 失败 (${registerResp.status}): ${JSON.stringify(registerResp.data).substring(0, 200)}`);
      }

      if (authState.pageType === 'create_account_password' || authState.pageType === 'email_otp_send') {
        await randomDelay(300, 800);
        const otpResp = await this.sendOtp(authState.referer);
        if (otpResp.status !== 200) {
          throw new Error(`Send OTP 失败 (${otpResp.status}): ${JSON.stringify(otpResp.data).substring(0, 200)}`);
        }
        if (!authState.pageType || authState.pageType === 'create_account_password') {
          markAuthState('email_otp_verification', `${this.AUTH}/email-verification`);
        }
      }
    }

    if (isOtpStage()) {
      needOtp = true;
    }

    if (authState.pageType === 'about_you') {
      this._checkCancelled();
      await randomDelay(500, 1500);
      const createResp = await this.createAccount(name, birthdate, authState.referer);
      syncAuthState('create-account', createResp, authState.referer);
      if (createResp.status !== 200) {
        throw new Error(`Create account 失败 (${createResp.status}): ${JSON.stringify(createResp.data).substring(0, 200)}`);
      }
      await randomDelay(200, 500);
      await this.callback(authState.continueUrl || this._callbackUrl);
      return true;
    }

    if (needOtp) {
      this._checkCancelled();
      const otpCode = await this.waitForVerificationEmail(email);
      if (!otpCode) throw new Error('未能获取验证码');

      await randomDelay(300, 800);
      let { status, data } = await this.validateOtp(otpCode, authState.referer);
      syncAuthState('validate-otp', { status, data }, authState.referer);
      if (status !== 200) {
        this._log('[注册] 验证码失败，重试...');
        const resendResp = await this.resendOtp(authState.referer);
        syncAuthState('resend-otp', resendResp, authState.referer);
        await randomDelay(1000, 2000);
        const otpCode2 = await this.waitForVerificationEmail(email, 60000);
        if (!otpCode2) throw new Error('重试后仍未获取验证码');
        await randomDelay(300, 800);
        ({ status, data } = await this.validateOtp(otpCode2, authState.referer));
        syncAuthState('validate-otp-retry', { status, data }, authState.referer);
        if (status !== 200) throw new Error(`验证码失败 (${status}): ${JSON.stringify(data)}`);
      }
    }

    this._checkCancelled();
    await randomDelay(500, 1500);
    const { status: createStatus, data: createData } = await this.createAccount(name, birthdate, authState.referer || `${this.AUTH}/about-you`);
    syncAuthState('create-account', { status: createStatus, data: createData }, authState.referer || `${this.AUTH}/about-you`);
    if (createStatus !== 200) throw new Error(`Create account 失败 (${createStatus}): ${JSON.stringify(createData)}`);
    await randomDelay(200, 500);
    await this.callback(authState.continueUrl || this._callbackUrl);
    return true;
  }

  // ==================== Codex OAuth 登录流程 ====================

  async _oauthFollowForCode(startUrl, referer, maxHops = 16) {
    let currentUrl = startUrl;
    let lastUrl = startUrl;
    const headers = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': this.ua,
    };
    if (referer) headers['Referer'] = referer;

    for (let hop = 0; hop < maxHops; hop++) {
      this._checkCancelled();
      try {
        const resp = await this._requestWithPreferredTransport(currentUrl, {
          method: 'GET',
          headers,
          maxRedirects: 0,
          preferChromeTls: this._isOpenAIAuthUrl(currentUrl),
        });
        lastUrl = currentUrl;
        this._log(`[OAuth] follow[${hop + 1}] ${resp.status} ${lastUrl.substring(0, 140)}`);

        let code = extractCodeFromUrl(lastUrl);
        if (code) return { code, url: lastUrl };

        if ([301, 302, 303, 307, 308].includes(resp.status)) {
          let loc = (resp.headers || {})['location'] || '';
          if (loc.startsWith('/')) loc = `${this.AUTH}${loc}`;
          code = extractCodeFromUrl(loc);
          if (code) return { code, url: loc };
          currentUrl = loc;
          headers['Referer'] = lastUrl;
          continue;
        }

        return { code: null, url: lastUrl };
      } catch (e) {
        // localhost 回调会连接失败，从错误消息中提取
        const match = String(e.message || e).match(/(https?:\/\/localhost[^\s'"]+)/);
        if (match) {
          const code = extractCodeFromUrl(match[1]);
          if (code) return { code, url: match[1] };
        }
        return { code: null, url: lastUrl };
      }
    }
    return { code: null, url: lastUrl };
  }

  _decodeOAuthSessionCookie() {
    const allCookies = { ...this.cookies['auth.openai.com'], ...this.cookies['.auth.openai.com'] };
    for (const [name, value] of Object.entries(allCookies)) {
      if (!name.includes('oai-client-auth-session')) continue;
      try {
        let val = decodeURIComponent(value);
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        const part = val.includes('.') ? val.split('.')[0] : val;
        // 兼容标准 base64 和 base64url 两种编码
        let raw;
        try {
          raw = Buffer.from(part, 'base64url').toString('utf8');
        } catch {
          raw = Buffer.from(part, 'base64').toString('utf8');
        }
        const data = JSON.parse(raw);
        if (typeof data === 'object') return data;
      } catch { /* ignore */ }
    }
    return null;
  }

  async _oauthSubmitWorkspaceAndOrg(consentUrl) {
    const sessionData = this._decodeOAuthSessionCookie();
    if (!sessionData) {
      this._log('[OAuth] 无法解码 oai-client-auth-session');
      return null;
    }

    const workspaces = sessionData.workspaces || [];
    if (!workspaces.length) {
      this._log('[OAuth] session 中没有 workspace 信息');
      return null;
    }

    const workspaceId = (workspaces[0] || {}).id;
    if (!workspaceId) {
      this._log('[OAuth] workspace_id 为空');
      return null;
    }

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': this.AUTH,
      'Referer': consentUrl,
      'User-Agent': this.ua,
      'oai-device-id': this.deviceId,
      ...makeTraceHeaders(),
    };

    // workspace/select
    const resp = await this._requestWithPreferredTransport(`${this.AUTH}/api/accounts/workspace/select`, {
      method: 'POST',
      headers,
      data: {
        workspace_id: workspaceId,
      },
      maxRedirects: 0,
      preferChromeTls: true,
    });
    this._log(`[OAuth] workspace/select -> ${resp.status}`);

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      let loc = (resp.headers || {})['location'] || '';
      if (loc.startsWith('/')) loc = `${this.AUTH}${loc}`;
      const code = extractCodeFromUrl(loc);
      if (code) return code;
      const result = await this._oauthFollowForCode(loc, consentUrl);
      return result.code;
    }

    if (resp.status !== 200) return null;

    const wsData = resp.data || {};
    const wsNext = wsData.continue_url || '';
    // 兼容两种响应结构：
    // 1) { data: { orgs: [...] } }           — 旧版
    // 2) { page: { payload: { data: { orgs: [...] } } } } — 新版 organization_select
    const wsPage = wsData.page || {};
    let orgs = (wsData.data || {}).orgs || [];
    if (!orgs.length && wsPage.type === 'organization_select') {
      orgs = ((wsPage.payload || {}).data || {}).orgs || [];
    }

    let orgId = null;
    let projectId = null;
    if (orgs.length) {
      orgId = (orgs[0] || {}).id;
      const projects = (orgs[0] || {}).projects || [];
      if (projects.length) projectId = (projects[0] || {}).id;
    }

    if (orgId) {
      const orgBody = { org_id: orgId };
      if (projectId) orgBody.project_id = projectId;
      else if ((orgs[0] || {}).default_project_id) orgBody.project_id = orgs[0].default_project_id;

      const orgHeaders = { ...headers };
      if (wsNext) {
        orgHeaders['Referer'] = wsNext.startsWith('http') ? wsNext : `${this.AUTH}${wsNext}`;
      }

      const respOrg = await this._requestWithPreferredTransport(`${this.AUTH}/api/accounts/organization/select`, {
        method: 'POST',
        headers: orgHeaders,
        data: orgBody,
        maxRedirects: 0,
        preferChromeTls: true,
      });
      this._log(`[OAuth] organization/select -> ${respOrg.status}`);

      if ([301, 302, 303, 307, 308].includes(respOrg.status)) {
        let loc = (respOrg.headers || {})['location'] || '';
        if (loc.startsWith('/')) loc = `${this.AUTH}${loc}`;
        const code = extractCodeFromUrl(loc);
        if (code) return code;
        const result = await this._oauthFollowForCode(loc, orgHeaders['Referer']);
        return result.code;
      }

      if (respOrg.status === 200) {
        const orgData = respOrg.data || {};
        const orgNext = orgData.continue_url || '';
        if (orgNext) {
          const fullUrl = orgNext.startsWith('/') ? `${this.AUTH}${orgNext}` : orgNext;
          const result = await this._oauthFollowForCode(fullUrl, orgHeaders['Referer']);
          return result.code;
        }
      }
    }

    if (wsNext) {
      const fullUrl = wsNext.startsWith('/') ? `${this.AUTH}${wsNext}` : wsNext;
      const result = await this._oauthFollowForCode(fullUrl, consentUrl);
      return result.code;
    }

    return null;
  }

  async performCodexOAuthLogin(email, password) {
    this._log('[OAuth] 开始执行 Codex OAuth 纯协议流程...');
    this._checkCancelled();

    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomBytes(18).toString('base64url');

    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: this.OAUTH_CLIENT_ID,
      redirect_uri: this.OAUTH_REDIRECT_URI,
      scope: 'openid profile email offline_access',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: state,
    });
    const authorizeUrl = `${this.AUTH}/oauth/authorize?${authorizeParams}`;

    const oauthJsonHeaders = (referer) => ({
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': this.AUTH,
      'Referer': referer,
      'User-Agent': this.ua,
      'oai-device-id': this.deviceId,
      ...makeTraceHeaders(),
    });

    // Step 1: Bootstrap OAuth session
    this._log('[OAuth] 1/7 GET /oauth/authorize');
    const bootstrapResp = await this._followRedirects(authorizeUrl, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': `${this.BASE}/`,
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': this.ua,
    });
    const authorizeFinaleUrl = bootstrapResp.url || '';
    this._log(`[OAuth] /oauth/authorize -> ${bootstrapResp.status}, final=${authorizeFinaleUrl.substring(0, 140)}`);

    const continueReferer = authorizeFinaleUrl.startsWith(this.AUTH) ? authorizeFinaleUrl : `${this.AUTH}/log-in`;

    // Step 2: POST /api/accounts/authorize/continue
    this._log('[OAuth] 2/7 POST /api/accounts/authorize/continue');
    this._checkCancelled();

    const sentinelAuthorize = await this._buildSentinelTokenForFlow('authorize_continue');
    if (!sentinelAuthorize) {
      this._log('[OAuth] authorize_continue 的 sentinel token 获取失败');
      return null;
    }

    const continueHeaders = oauthJsonHeaders(continueReferer);
    continueHeaders['openai-sentinel-token'] = sentinelAuthorize;

    let respContinue = await this._requestWithPreferredTransport(`${this.AUTH}/api/accounts/authorize/continue`, {
      method: 'POST',
      headers: continueHeaders,
      data: {
        username: { kind: 'email', value: email },
        screen_hint: 'login',
      },
      maxRedirects: 0,
      preferChromeTls: true,
    });

    this._log(`[OAuth] /authorize/continue -> ${respContinue.status}`);

    if (respContinue.status === 400 && String(respContinue.data).includes('invalid_auth_step')) {
      this._log('[OAuth] invalid_auth_step，重新 bootstrap 后重试');
      await this._followRedirects(authorizeUrl, {
        'Accept': 'text/html,*/*;q=0.8',
        'Referer': `${this.BASE}/`,
        'Upgrade-Insecure-Requests': '1',
      });
      const sentinelRetry = await buildSentinelToken(this.httpClient, this.deviceId, 'authorize_continue', this.ua, this.secChUa);
      if (sentinelRetry) {
        const retryHeaders = oauthJsonHeaders(continueReferer);
        retryHeaders['openai-sentinel-token'] = sentinelRetry;
        respContinue = await this._requestWithPreferredTransport(`${this.AUTH}/api/accounts/authorize/continue`, {
          method: 'POST',
          headers: retryHeaders,
          data: {
            username: { kind: 'email', value: email },
            screen_hint: 'login',
          },
          maxRedirects: 0,
          preferChromeTls: true,
        });
        this._log(`[OAuth] /authorize/continue(重试) -> ${respContinue.status}`);
      }
    }

    if (respContinue.status !== 200) {
      this._log(`[OAuth] 邮箱提交失败: ${JSON.stringify(respContinue.data).substring(0, 180)}`);
      return null;
    }

    const continueData = respContinue.data || {};
    let continueUrl = continueData.continue_url || '';
    let pageType = (continueData.page || {}).type || '';
    this._log(`[OAuth] continue page=${pageType || '-'} next=${(continueUrl || '-').substring(0, 140)}`);

    // 访问 continue_url 推进会话状态（参考实现关键步骤）
    if (continueUrl) {
      const absUrl = continueUrl.startsWith('/') ? `${this.AUTH}${continueUrl}` : continueUrl;
      if (absUrl.startsWith(this.AUTH)) {
        try {
          await this._requestWithPreferredTransport(absUrl, {
            method: 'GET',
            headers: { 'Accept': 'text/html,*/*;q=0.8', 'User-Agent': this.ua, 'Referer': continueReferer },
            maxRedirects: 5,
            preferChromeTls: true,
          });
          this._log(`[OAuth] GET continue_url -> OK`);
        } catch (e) {
          this._log(`[OAuth] GET continue_url -> ${e.message}`);
        }
      }
    }

    // Step 3: POST /api/accounts/password/verify
    this._log('[OAuth] 3/7 POST /api/accounts/password/verify');
    this._checkCancelled();

    const sentinelPwd = await buildSentinelToken(this.httpClient, this.deviceId, 'password_verify', this.ua, this.secChUa);
    if (!sentinelPwd) {
      this._log('[OAuth] password_verify 的 sentinel token 获取失败');
      return null;
    }

    const verifyHeaders = oauthJsonHeaders(`${this.AUTH}/log-in/password`);
    verifyHeaders['openai-sentinel-token'] = sentinelPwd;

    const respVerify = await this._requestWithPreferredTransport(`${this.AUTH}/api/accounts/password/verify`, {
      method: 'POST',
      headers: verifyHeaders,
      data: {
        password: password,
      },
      maxRedirects: 0,
      preferChromeTls: true,
    });

    this._log(`[OAuth] /password/verify -> ${respVerify.status}`);
    if (respVerify.status !== 200) {
      this._log(`[OAuth] 密码校验失败: ${JSON.stringify(respVerify.data).substring(0, 180)}`);
      return null;
    }

    const verifyData = respVerify.data || {};
    continueUrl = verifyData.continue_url || continueUrl;
    pageType = (verifyData.page || {}).type || pageType;
    this._log(`[OAuth] verify page=${pageType || '-'} next=${(continueUrl || '-').substring(0, 140)}`);

    // Step 4: Optional email OTP
    const needOtp = (
      pageType === 'email_otp_verification' ||
      (continueUrl && (continueUrl.includes('email-verification') || continueUrl.includes('email-otp')))
    );

    if (needOtp) {
      this._log('[OAuth] 4/7 检测到邮箱 OTP 验证');

      // 记录 OTP 发送请求时间，用于过滤注册阶段的旧验证码邮件
      const otpRequestTime = new Date(Date.now() - 30000); // 减去30秒缓冲，兼容服务器时钟差异

      // 访问 email-verification 页面触发服务端发送 OTP（参考实现关键步骤）
      try {
        await this._requestWithPreferredTransport(`${this.AUTH}/email-verification`, {
          method: 'GET',
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': `${this.AUTH}/log-in/password`,
            'User-Agent': this.ua,
          },
          maxRedirects: 5,
          preferChromeTls: true,
        });
        this._log('[OAuth] 已访问 email-verification 页面触发 OTP 发送');
      } catch (e) {
        this._log(`[OAuth] 访问 email-verification 页面失败: ${e.message}`);
      }
      await randomDelay(2000, 3000);

      const otpHeaders = oauthJsonHeaders(`${this.AUTH}/email-verification`);
      let otpSuccess = false;

      // 通过 IMAP 获取验证码（传入 notBefore 避免拿到注册阶段已消费的旧验证码）
      const otpCode = await this.waitForVerificationEmail(email, 120000, otpRequestTime);
      if (otpCode) {
        this._log(`[OAuth] 尝试 OTP: ${otpCode}`);
        const respOtp = await this._requestWithPreferredTransport(`${this.AUTH}/api/accounts/email-otp/validate`, {
          method: 'POST',
          headers: otpHeaders,
          data: {
            code: otpCode,
          },
          maxRedirects: 0,
          preferChromeTls: true,
        });

        this._log(`[OAuth] /email-otp/validate -> ${respOtp.status}`);
        if (respOtp.status === 200) {
          const otpData = respOtp.data || {};
          continueUrl = otpData.continue_url || continueUrl;
          pageType = (otpData.page || {}).type || pageType;
          this._log(`[OAuth] OTP 验证通过 page=${pageType || '-'}`);
          otpSuccess = true;
        }
      }

      if (!otpSuccess) {
        this._log(`[OAuth] OAuth 阶段 OTP 验证失败`);
        return null;
      }
    }

    // Step 5-6: Follow continue_url to get authorization code
    let code = null;
    let consentUrl = continueUrl;
    if (consentUrl && consentUrl.startsWith('/')) consentUrl = `${this.AUTH}${consentUrl}`;
    if (!consentUrl && pageType.includes('consent')) {
      consentUrl = `${this.AUTH}/sign-in-with-chatgpt/codex/consent`;
    }

    if (consentUrl) code = extractCodeFromUrl(consentUrl);

    if (!code && consentUrl) {
      this._log('[OAuth] 5/7 跟随 continue_url 提取 code');
      const result = await this._oauthFollowForCode(consentUrl, `${this.AUTH}/log-in/password`);
      code = result.code;
    }

    const consentHint = (
      (consentUrl && (consentUrl.includes('consent') || consentUrl.includes('sign-in-with-chatgpt') ||
        consentUrl.includes('workspace') || consentUrl.includes('organization'))) ||
      pageType.includes('consent') || pageType.includes('organization')
    );

    if (!code && consentHint) {
      if (!consentUrl) consentUrl = `${this.AUTH}/sign-in-with-chatgpt/codex/consent`;
      this._log('[OAuth] 6/7 执行 workspace/org 选择');
      code = await this._oauthSubmitWorkspaceAndOrg(consentUrl);
    }

    if (!code) {
      const fallbackConsent = `${this.AUTH}/sign-in-with-chatgpt/codex/consent`;
      this._log('[OAuth] 6/7 回退 consent 路径重试');
      code = await this._oauthSubmitWorkspaceAndOrg(fallbackConsent);
      if (!code) {
        const result = await this._oauthFollowForCode(fallbackConsent, `${this.AUTH}/log-in/password`);
        code = result.code;
      }
    }

    if (!code) {
      this._log('[OAuth] 未获取到 authorization code');
      return null;
    }

    // Step 7: Exchange code for tokens
    this._log('[OAuth] 7/7 POST /oauth/token');
    this._checkCancelled();

    const tokenResp = await this._requestWithPreferredTransport(`${this.AUTH}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.ua,
      },
      data: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: this.OAUTH_REDIRECT_URI,
        client_id: this.OAUTH_CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
      preferChromeTls: true,
    });

    this._log(`[OAuth] /oauth/token -> ${tokenResp.status}`);

    if (tokenResp.status !== 200) {
      this._log(`[OAuth] token 交换失败: ${tokenResp.status} ${JSON.stringify(tokenResp.data).substring(0, 200)}`);
      return null;
    }

    if (!tokenResp.data?.access_token) {
      this._log('[OAuth] token 响应缺少 access_token');
      return null;
    }

    this._log('[OAuth] Codex Token 获取成功');
    return tokenResp.data;
  }
}

// ================= 批量注册管理器 =================
class CodexBatchRegistrar {
  constructor(options = {}) {
    this.emailConfig = options.emailConfig || null;
    this.emailDomains = options.emailDomains || [];
    // 代理优先级：用户配置 > 环境变量 (HTTPS_PROXY/HTTP_PROXY/ALL_PROXY)
    this.proxy = options.proxy || this._detectSystemProxy();
    this.enableOAuth = options.enableOAuth !== false;
    this.cancelled = false;
    this._logCallback = options.logCallback || null;
    this._progressCallback = options.progressCallback || null;
  }

  _detectSystemProxy() {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
      const val = (process.env[key] || '').trim();
      if (val) return val;
    }
    return '';
  }

  _log(msg) {
    console.log(msg);
    if (this._logCallback) this._logCallback(msg);
  }

  cancel() {
    this.cancelled = true;
  }

  async registerOne(index, total) {
    if (this.cancelled) throw new Error('用户取消操作');

    const reg = new ChatGPTRegister({
      tag: String(index),
      proxy: this.proxy,
      logCallback: this._logCallback,
      emailConfig: this.emailConfig,
      emailDomains: this.emailDomains,
    });

    try {
      // 1. 生成注册邮箱（域名 Catch-All → QQ IMAP）
      this._log(`[${index}/${total}] 生成注册邮箱...`);
      const { email, password: chatgptPassword } = reg.createTempEmail();
      reg.tag = email.split('@')[0];

      const name = randomName();
      const birthdate = randomBirthdate();

      this._log(`[${index}/${total}] 注册: ${email}`);
      this._log(`[${index}/${total}] 密码: ${chatgptPassword}`);

      // 2. 执行注册
      await reg.runRegister(email, chatgptPassword, name, birthdate);

      // 3. OAuth Token
      let tokens = null;
      if (this.enableOAuth) {
        this._log(`[${index}/${total}] 获取 Codex Token...`);
        tokens = await reg.performCodexOAuthLogin(email, chatgptPassword);
        if (tokens) {
          this._log(`[${index}/${total}] Token 获取成功`);
        } else {
          this._log(`[${index}/${total}] Token 获取失败`);
        }
      }

      // OAuth 开启时，Token 获取失败视为注册未完成
      if (this.enableOAuth && !tokens) {
        return {
          success: false,
          error: 'ChatGPT 账号注册成功，但 Codex OAuth Token 获取失败',
          email,
          chatgptPassword,
          name,
          tokens: null,
          partialSuccess: true,
        };
      }

      return {
        success: true,
        email,
        chatgptPassword,
        name,
        tokens,
      };
    } catch (error) {
      this._log(`[${index}/${total}] 注册失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async saveTokens(result, outputDir) {
    if (!result.success || !result.tokens) return;

    const CONSTANTS = getConstants();
    const tokensDir = path.join(outputDir, CONSTANTS.CODEX_TOKEN_DIR);
    await fs.mkdir(tokensDir, { recursive: true });

    const { email, tokens } = result;
    const payload = decodeJwtPayload(tokens.access_token || '');
    const authInfo = (payload['https://api.openai.com/auth'] || {});

    const tokenData = {
      type: 'codex',
      email,
      account_id: authInfo.chatgpt_account_id || '',
      access_token: tokens.access_token || '',
      refresh_token: tokens.refresh_token || '',
      id_token: tokens.id_token || '',
      last_refresh: new Date().toISOString(),
    };

    // 保存单个 JSON
    await fs.writeFile(path.join(tokensDir, `${email}.json`), JSON.stringify(tokenData, null, 2), 'utf8');

    // 追加到 ak/rk 文件
    if (tokens.access_token) {
      await fs.appendFile(path.join(outputDir, CONSTANTS.CODEX_AK_FILE), tokens.access_token + '\n', 'utf8');
    }
    if (tokens.refresh_token) {
      await fs.appendFile(path.join(outputDir, CONSTANTS.CODEX_RK_FILE), tokens.refresh_token + '\n', 'utf8');
    }
  }

  async runBatch(totalAccounts, outputDir) {
    if (!this.emailConfig || !this.emailConfig.user || !this.emailConfig.password) {
      throw new Error('未配置 IMAP 邮箱，请在「系统设置」中配置');
    }
    if (!this.emailDomains || this.emailDomains.length === 0) {
      throw new Error('未配置邮箱域名，请在「系统设置」中添加域名');
    }

    this._log(`========== Codex 批量注册开始 ==========`);
    this._log(`注册数量: ${totalAccounts}`);
    this._log(`OAuth: ${this.enableOAuth ? '开启' : '关闭'}`);
    this._log(`代理: ${this.proxy || '未设置'}`);

    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 1; i <= totalAccounts; i++) {
      if (this.cancelled) {
        this._log('用户取消注册');
        break;
      }

      try {
        const result = await this.registerOne(i, totalAccounts);
        results.push(result);

        if (result.success) {
          successCount++;
          await this.saveTokens(result, outputDir);

          // 保存注册结果
          const line = `${result.email}----${result.chatgptPassword}----oauth=${result.tokens ? 'ok' : 'fail'}\n`;
          await fs.appendFile(path.join(outputDir, 'codex_registered_accounts.txt'), line, 'utf8');
        } else if (result.partialSuccess) {
          // 注册成功但 Token 获取失败，仍保存账号信息以便后续手动获取 Token
          failCount++;
          const line = `${result.email}----${result.chatgptPassword}----oauth=fail (${result.error || 'Token获取失败'})\n`;
          await fs.appendFile(path.join(outputDir, 'codex_registered_accounts.txt'), line, 'utf8');
          this._log(`[${i}/${totalAccounts}] ${result.error}`);
        } else {
          failCount++;
        }

        if (this._progressCallback) {
          this._progressCallback({ current: i, total: totalAccounts, success: successCount, fail: failCount });
        }
      } catch (error) {
        failCount++;
        this._log(`[${i}/${totalAccounts}] 异常: ${error.message}`);
      }

      // 账号之间的间隔
      if (i < totalAccounts && !this.cancelled) {
        await new Promise(resolve => setTimeout(resolve, randomInt(2000, 5000)));
      }
    }

    this._log(`========== 注册完成 ==========`);
    this._log(`总数: ${totalAccounts} | 成功: ${successCount} | 失败: ${failCount}`);

    return { results, successCount, failCount };
  }
}

module.exports = {
  ChatGPTRegister,
  CodexBatchRegistrar,
  SentinelTokenGenerator,
  generatePassword,
  randomName,
  randomBirthdate,
};
