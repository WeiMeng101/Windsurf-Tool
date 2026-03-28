'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const packageJson = require('../package.json');

function loadGatewayDbWithBetterSqliteFailure(message) {
  const dbModulePath = require.resolve('../src/gateway/db');
  const originalLoad = Module._load;

  delete require.cache[dbModulePath];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'better-sqlite3') {
      throw new Error(message);
    }

    if (request === 'electron') {
      return {
        app: {
          getPath: () => path.join(__dirname, '.tmp-user-data'),
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../src/gateway/db');
  } finally {
    Module._load = originalLoad;
  }
}

describe('Native dependency scripts', () => {
  it('defines a rebuild:native script for Electron ABI rebuilds', () => {
    assert.equal(
      packageJson.scripts['rebuild:native'],
      'electron-builder install-app-deps'
    );
  });

  it('runs the native rebuild during postinstall', () => {
    assert.match(packageJson.scripts.postinstall, /rebuild:native/);
  });
});

describe('Gateway DB diagnostics', () => {
  it('surfaces rebuild guidance when better-sqlite3 cannot be loaded', () => {
    const dbModule = loadGatewayDbWithBetterSqliteFailure('ABI mismatch between Node and Electron');

    assert.throws(
      () => dbModule.getDb(),
      /rebuild:native|electron-builder install-app-deps|ABI mismatch between Node and Electron/
    );
  });
});
