'use strict';

const axios = require('axios');
const logger = require('../logger');

// ---------------------------------------------------------------------------
// Refresh-lock registry (module-level singleton)
// Ensures only one refresh runs per account at a time.
// Map<accountId, Promise<result>>
// ---------------------------------------------------------------------------
const _refreshLocks = new Map();

/**
 * Execute a refresh function for the given accountId, guaranteeing that
 * concurrent callers share the same in-flight promise rather than
 * spawning duplicate refresh requests.
 *
 * @param {string} accountId - Unique identifier for the account
 * @param {() => Promise<any>} refreshFn - The actual refresh logic
 * @returns {Promise<any>} The result of refreshFn
 */
async function refreshWithLock(accountId, refreshFn) {
  // If a refresh is already in progress for this account, return the same promise
  if (_refreshLocks.has(accountId)) {
    logger.info(`Refresh already in progress for account ${accountId}, waiting for existing`);
    return _refreshLocks.get(accountId);
  }

  const promise = refreshFn().finally(() => {
    _refreshLocks.delete(accountId);
  });

  _refreshLocks.set(accountId, promise);
  return promise;
}

class OAuthTokenProvider {
  constructor(params) {
    this.credentials = params.credentials || {};
    this.oauthUrls = params.oauthUrls || {};
    this.userAgent = params.userAgent || '';
    this.onRefreshed = params.onRefreshed || null;
    this.currentToken = null;
    this.tokenExpiresAt = null;
    this.refreshTimer = null;
    this.refreshing = false;
    /** Optional account id used to coordinate refreshes across providers. */
    this.accountId = params.accountId || null;
  }

  getCurrentToken() {
    return this.currentToken || this.credentials.access_token;
  }

  isExpired() {
    if (!this.tokenExpiresAt) return true;
    return Date.now() >= this.tokenExpiresAt - 60000;
  }

  async refreshToken() {
    // If an accountId is set, use the global lock to deduplicate refreshes
    if (this.accountId) {
      return refreshWithLock(this.accountId, () => this._doRefresh());
    }

    // Fallback: simple boolean guard (original behaviour)
    if (this.refreshing) return this.currentToken;
    return this._doRefresh();
  }

  /** Internal: performs the actual token refresh HTTP call. */
  async _doRefresh() {
    this.refreshing = true;

    try {
      const refreshTokenVal = this.credentials.refresh_token;
      if (!refreshTokenVal) {
        throw new Error('No refresh token available');
      }

      const response = await axios.post(this.oauthUrls.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: refreshTokenVal,
        client_id: this.credentials.client_id || 'app_EMoamEEZ73f0CkXaXp7hrann',
      }, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
        },
      });

      const data = response.data;
      this.currentToken = data.access_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;

      if (data.refresh_token) {
        this.credentials.refresh_token = data.refresh_token;
      }
      this.credentials.access_token = data.access_token;

      logger.info('OAuth token refreshed successfully');

      if (this.onRefreshed) {
        await this.onRefreshed(this.credentials);
      }

      return this.currentToken;
    } catch (err) {
      logger.error('OAuth token refresh failed', { error: err.message });
      throw err;
    } finally {
      this.refreshing = false;
    }
  }

  async getToken() {
    if (!this.isExpired() && this.currentToken) {
      return this.currentToken;
    }
    return this.refreshToken();
  }

  startAutoRefresh(intervalMs, refreshBeforeMs) {
    const interval = intervalMs || 3000000;
    const refreshBefore = refreshBeforeMs || 300000;

    this.stopAutoRefresh();
    this.refreshTimer = setInterval(async () => {
      try {
        if (this.isExpired() || (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt - refreshBefore)) {
          await this.refreshToken();
        }
      } catch (err) {
        logger.error('Auto refresh failed', { error: err.message });
      }
    }, Math.min(interval, 60000));

    logger.info('OAuth auto-refresh started');
  }

  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Full cleanup — stop timers and clear state.
   * Call this when the provider instance is no longer needed.
   */
  destroy() {
    this.stopAutoRefresh();
    this.currentToken = null;
    this.tokenExpiresAt = null;
  }
}

class DeviceFlowProvider {
  constructor(params) {
    this.oauthUrls = params.oauthUrls;
    this.clientId = params.clientId;
    this.scopes = params.scopes;
  }

  async initiateDeviceFlow() {
    const response = await axios.post(`${this.oauthUrls.authorizeUrl}/device/code`, {
      client_id: this.clientId,
      scope: this.scopes,
    });
    return response.data;
  }

  async pollForToken(deviceCode, interval) {
    const pollInterval = (interval || 5) * 1000;
    const maxAttempts = 60;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, pollInterval));
      try {
        const response = await axios.post(this.oauthUrls.tokenUrl, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: this.clientId,
        });
        return response.data;
      } catch (err) {
        const error = err.response?.data?.error;
        if (error === 'authorization_pending') continue;
        if (error === 'slow_down') {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Device flow polling timed out');
  }
}

module.exports = { OAuthTokenProvider, DeviceFlowProvider, refreshWithLock };
