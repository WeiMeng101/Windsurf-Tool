'use strict';

const NodeCache = require('node-cache');

const defaultCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
});

const shortCache = new NodeCache({
  stdTTL: 5,
  checkperiod: 10,
  useClones: false,
});

class CacheManager {
  constructor() {
    this.caches = {
      default: defaultCache,
      short: shortCache,
      channels: new NodeCache({ stdTTL: 10, checkperiod: 15, useClones: false }),
      models: new NodeCache({ stdTTL: 60, checkperiod: 120, useClones: false }),
      system: new NodeCache({ stdTTL: 300, checkperiod: 600, useClones: false }),
    };
  }

  get(cacheName, key) {
    const cache = this.caches[cacheName] || this.caches.default;
    return cache.get(key);
  }

  set(cacheName, key, value, ttl) {
    const cache = this.caches[cacheName] || this.caches.default;
    return cache.set(key, value, ttl);
  }

  del(cacheName, key) {
    const cache = this.caches[cacheName] || this.caches.default;
    return cache.del(key);
  }

  flush(cacheName) {
    if (cacheName) {
      const cache = this.caches[cacheName];
      if (cache) cache.flushAll();
    } else {
      Object.values(this.caches).forEach(c => c.flushAll());
    }
  }

  close() {
    Object.values(this.caches).forEach(c => c.close());
  }
}

const cacheManager = new CacheManager();

module.exports = { cacheManager, CacheManager };
