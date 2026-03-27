'use strict';

const axios = require('axios');
const logger = require('../logger');

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
  }

  getCurrentToken() {
    return this.currentToken || this.credentials.access_token;
  }

  isExpired() {
    if (!this.tokenExpiresAt) return true;
    return Date.now() >= this.tokenExpiresAt - 60000;
  }

  async refreshToken() {
    if (this.refreshing) return this.currentToken;
    this.refreshing = true;

    try {
      const refreshToken = this.credentials.refresh_token;
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      const response = await axios.post(this.oauthUrls.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
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

module.exports = { OAuthTokenProvider, DeviceFlowProvider };
