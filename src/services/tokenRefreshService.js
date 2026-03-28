'use strict';

const axios = require('axios');
const { isTokenExpired } = require('./tokenUtils');

// Default Codex OAuth constants (same as renderer/constants.js)
const CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

class TokenRefreshService {
  /**
   * Refresh a Codex/OpenAI account token using refresh_token.
   * Calls the OpenAI auth endpoint with grant_type=refresh_token.
   *
   * @param {string} refreshToken - The refresh_token value (e.g. rt_dN-jLA0yt5...)
   * @param {object} [options]
   * @param {string} [options.issuer] - OAuth issuer base URL
   * @param {string} [options.clientId] - OAuth client ID
   * @param {number} [options.timeout] - Request timeout in ms
   * @returns {Promise<{ access_token: string, refresh_token?: string, expires_in?: number }>}
   */
  async refreshCodexToken(refreshToken, options = {}) {
    const issuer = options.issuer || CODEX_OAUTH_ISSUER;
    const clientId = options.clientId || CODEX_OAUTH_CLIENT_ID;
    const timeout = options.timeout || 30000;

    const resp = await axios.post(
      `${issuer}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout,
        validateStatus: () => true,
      },
    );

    if (resp.status !== 200 || !resp.data?.access_token) {
      const body = JSON.stringify(resp.data || {}).substring(0, 300);
      throw new Error(`Codex token refresh failed (HTTP ${resp.status}): ${body}`);
    }

    return {
      access_token: resp.data.access_token,
      refresh_token: resp.data.refresh_token || undefined,
      expires_in: resp.data.expires_in || undefined,
    };
  }

  /**
   * Refresh token based on provider type.
   * Currently supports 'codex' provider; throws for unsupported providers.
   *
   * @param {object} account - Pool account object with credentials
   * @param {object} [account.credentials] - Credentials containing refresh_token
   * @param {string} [account.provider_type] - Provider type (e.g. 'codex')
   * @returns {Promise<{ access_token: string, refresh_token?: string, expires_in?: number }>}
   */
  async refreshToken(account) {
    const creds = account.credentials || {};
    const refreshToken = creds.refresh_token || creds.refreshToken;

    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const providerType = (account.provider_type || '').toLowerCase();

    switch (providerType) {
      case 'codex':
        return this.refreshCodexToken(refreshToken);
      default:
        throw new Error(`Token refresh not supported for provider: ${account.provider_type || 'unknown'}`);
    }
  }

  /**
   * Check whether an account's access_token is expired and needs refresh.
   *
   * @param {object} account - Pool account object
   * @returns {boolean} true if the access_token is expired or missing
   */
  needsRefresh(account) {
    const creds = account.credentials || {};
    const accessToken = creds.access_token || creds.accessToken;
    if (!accessToken) return true;
    return isTokenExpired(accessToken);
  }
}

// Export singleton instance for convenience
const tokenRefreshService = new TokenRefreshService();

module.exports = tokenRefreshService;
module.exports.TokenRefreshService = TokenRefreshService;
