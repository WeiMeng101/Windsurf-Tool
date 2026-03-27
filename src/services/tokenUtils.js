/**
 * Token 工具模块 — JWT 解码与过期检查
 * 统一供 tokenGetter / codexAccountSwitcher / codexRegistrationBot 等使用
 */

/**
 * 解码 JWT payload（不验证签名）
 * @param {string} token - JWT token 字符串
 * @returns {Object} 解析后的 payload，解析失败返回 {}
 */
function decodeJwtPayload(token) {
  if (!token) return {};
  try {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    const raw = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 检查 JWT token 是否已过期
 * @param {string} token - JWT token 字符串
 * @param {number} marginMs - 安全余量(ms)，默认 60000（1 分钟）
 * @returns {boolean} true = 已过期或无法解析
 */
function isTokenExpired(token, marginMs = 60000) {
  const payload = decodeJwtPayload(token);
  if (!payload.exp) return true;
  return (payload.exp * 1000) <= (Date.now() + marginMs);
}

module.exports = { decodeJwtPayload, isTokenExpired };
