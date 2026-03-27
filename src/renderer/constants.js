// 在 Node.js / Electron 环境下加载 .env
if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
  try { require('dotenv').config(); } catch (e) { /* dotenv not installed or .env missing */ }
}

/**
 * 全局常量配置
 */
const CONSTANTS = {
  // Cloudflare Worker 中转地址
  WORKER_URL: 'https://windsurf.hfhddfj.cn',

  // Cloudflare Worker 访问密钥（用于验证请求来源，防止滥用）
  // 必须与 Cloudflare Workers 中的 SECRET_KEY 一致
  // 从环境变量读取，需在 .env 文件中配置
  WORKER_SECRET_KEY: process.env.WORKER_SECRET_KEY || '',

  // Firebase API Key
  // 从环境变量读取，需在 .env 文件中配置
  FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || '',

  // Windsurf 注册 API
  WINDSURF_REGISTER_API: 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser',

  // 请求超时时间 (ms)
  REQUEST_TIMEOUT: 30000,

  // ============= Codex (OpenAI) 相关配置 =============
  // OAuth 配置
  CODEX_OAUTH_ISSUER: 'https://auth.openai.com',
  CODEX_OAUTH_CLIENT_ID: 'app_EMoamEEZ73f0CkXaXp7hrann',
  CODEX_OAUTH_REDIRECT_URI: 'http://localhost:1455/auth/callback',

  // ChatGPT 基础地址
  CODEX_CHATGPT_BASE: 'https://chatgpt.com',

  // Sentinel API
  CODEX_SENTINEL_URL: 'https://sentinel.openai.com/backend-api/sentinel/req',

  // Codex Token 文件名
  CODEX_AK_FILE: 'codex_ak.txt',
  CODEX_RK_FILE: 'codex_rk.txt',
  CODEX_TOKEN_DIR: 'codex_tokens'
};

module.exports = CONSTANTS;
