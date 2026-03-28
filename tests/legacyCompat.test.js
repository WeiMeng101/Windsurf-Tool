'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const packageJson = require('../package.json');

function withMockedElectron(mockElectron, callback) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return mockElectron;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return callback();
  } finally {
    Module._load = originalLoad;
  }
}

describe('Legacy compatibility shims', () => {
  it('re-exports legacy js modules used by the main process', async () => {
    const baseElectronMock = {
      app: {
        getPath: (name) => {
          if (name === 'home') return path.join(__dirname, '.tmp-home');
          if (name === 'appData') return path.join(__dirname, '.tmp-app-data');
          return path.join(__dirname, '.tmp-other');
        },
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('not needed in compatibility test');
        },
        decryptString: () => {
          throw new Error('not needed in compatibility test');
        },
      },
    };

    await withMockedElectron(baseElectronMock, async () => {
      const { AccountSwitcher, WindsurfPathDetector, WindsurfPathService } = require('../js/accountSwitcher');
      const { CodexAccountPool } = require('../js/codexAccountSwitcher');
      const { AccountLogin } = require('../js/accountLogin');
      const { CurrentAccountDetector } = require('../js/currentAccountDetector');
      const AccountQuery = require('../js/accountQuery');
      const constants = require('../js/constants');

      assert.equal(typeof AccountSwitcher, 'function');
      assert.equal(typeof WindsurfPathDetector.getDBPath, 'function');
      assert.equal(typeof WindsurfPathService.getDBPath, 'function');
      assert.equal(typeof CodexAccountPool, 'function');
      assert.equal(typeof AccountLogin, 'function');
      assert.equal(typeof CurrentAccountDetector.getCurrentAccount, 'function');
      assert.equal(typeof AccountQuery.queryAccount, 'function');
      assert.equal(typeof constants.WORKER_URL, 'string');
    });
  });
});

describe('Main-process smoke contracts', () => {
  it('defines an npm test script for the node:test regression suite', () => {
    assert.equal(packageJson.scripts.test, 'node --test tests/*.test.js');
  });

  it('defines a single command that runs the regression chain end-to-end', () => {
    assert.equal(
      packageJson.scripts['test:chain'],
      'npm test && npm run test:smoke && node _verify_refactor.js'
    );
  });

  it('registers a check-for-updates IPC handler with a safe default response', async () => {
    const handlers = new Map();
    const mockElectron = {
      app: {
        getVersion: () => '6.4.1',
        getPath: (name) => {
          if (name === 'documents') return path.join(__dirname, '.tmp-documents');
          return path.join(__dirname, '.tmp-app');
        },
        isPackaged: false,
      },
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
        on() {},
      },
      shell: {
        openExternal: async () => {},
      },
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
      },
    };

    await withMockedElectron(mockElectron, async () => {
      const systemModulePath = require.resolve('../src/main/ipc/system');
      delete require.cache[systemModulePath];
      const systemHandlers = require('../src/main/ipc/system');

      systemHandlers.registerHandlers(
        {
          webContents: {
            isDevToolsOpened: () => false,
            closeDevTools: () => {},
          },
        },
        {
          appRoot: path.join(__dirname, '..'),
          state: {},
        }
      );
    });

    assert.ok(handlers.has('check-for-updates'), 'check-for-updates handler should be registered');

    const result = await handlers.get('check-for-updates')();
    assert.equal(result.hasUpdate, false);
    assert.equal(result.currentVersion, '6.4.1');
    assert.equal(result.latestVersion, '6.4.1');
    assert.equal(result.forceUpdate, false);
    assert.equal(result.success, true);
  });

  it('keeps renderer invoke channels covered by main-process handlers', () => {
    const root = path.join(__dirname, '..');
    const sourceFiles = [];

    function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === '参考') continue;
        const fullPath = path.join(dir, name);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (/\.(js|ts|tsx|jsx)$/.test(name)) {
          sourceFiles.push(fullPath);
        }
      }
    }

    walk(path.join(root, 'src'));
    sourceFiles.push(path.join(root, 'main.js'));
    sourceFiles.push(path.join(root, 'renderer.js'));

    const invokes = new Set();
    const handles = new Set();
    const ons = new Set();

    for (const file of sourceFiles) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');

      for (const match of text.matchAll(/invoke\('([^']+)'/g)) invokes.add(match[1]);
      for (const match of text.matchAll(/safeIpcInvoke\('([^']+)'/g)) invokes.add(match[1]);
      for (const match of text.matchAll(/ipcMain\.handle\('([^']+)'/g)) handles.add(match[1]);
      for (const match of text.matchAll(/ipcMain\.on\('([^']+)'/g)) ons.add(match[1]);
    }

    const missingChannels = [...invokes]
      .filter(channel => !handles.has(channel) && !ons.has(channel))
      .sort();

    assert.deepEqual(missingChannels, []);
  });
});
