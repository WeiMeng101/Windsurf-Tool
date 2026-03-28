'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function waitForTick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitUntil(predicate, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await waitForTick();
  }
  throw new Error('Timed out waiting for bootstrap condition');
}

describe('Main process bootstrap smoke', () => {
  it('boots main.js with mocked Electron and registers startup handlers', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-main-'));
    const appDataPath = path.join(tempRoot, 'appData');
    const documentsPath = path.join(tempRoot, 'Documents');
    fs.mkdirSync(appDataPath, { recursive: true });
    fs.mkdirSync(documentsPath, { recursive: true });

    const registeredHandlers = new Map();
    const browserWindows = [];

    const mockApp = {
      _paths: {
        appData: appDataPath,
        userData: path.join(appDataPath, 'windsurf-tool'),
        documents: documentsPath,
        home: tempRoot,
      },
      setName(name) {
        this._name = name;
      },
      getPath(name) {
        return this._paths[name] || tempRoot;
      },
      setPath(name, value) {
        this._paths[name] = value;
      },
      getVersion() {
        return '6.4.1';
      },
      whenReady() {
        return Promise.resolve();
      },
      on() {},
      quit() {},
      isPackaged: false,
    };

    class MockBrowserWindow {
      constructor(options) {
        this.options = options;
        this._destroyed = false;
        this._windowEvents = new Map();
        browserWindows.push(this);
        this.webContents = {
          _events: new Map(),
          on: (event, callback) => {
            this.webContents._events.set(event, callback);
          },
          send: () => {},
          reload: () => {},
          openDevTools: () => {},
          isDevToolsOpened: () => false,
          closeDevTools: () => {},
        };
      }

      once(event, callback) {
        this._windowEvents.set(event, callback);
        if (event === 'ready-to-show') {
          callback();
        }
      }

      show() {
        this._shown = true;
      }

      loadFile() {
        return Promise.resolve();
      }

      isDestroyed() {
        return this._destroyed;
      }

      static getAllWindows() {
        return browserWindows;
      }
    }

    const fakeDb = {
      prepare() {
        return {
          all: () => [],
          get: () => null,
          run: () => ({ changes: 1, lastInsertRowid: 1 }),
        };
      },
      transaction(fn) {
        return fn;
      },
    };

    class FakeGatewayServer {
      constructor(options = {}) {
        this.port = options.port || 8090;
      }

      start() {
        return Promise.resolve();
      }

      stop() {
        return Promise.resolve();
      }
    }

    const mockElectron = {
      app: mockApp,
      BrowserWindow: MockBrowserWindow,
      ipcMain: {
        handle(channel, handler) {
          registeredHandlers.set(channel, handler);
        },
        on(channel, handler) {
          registeredHandlers.set(`on:${channel}`, handler);
        },
        removeAllListeners() {},
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
      },
      dialog: {
        showErrorBox() {},
        showSaveDialog: async () => ({ canceled: true }),
      },
      Menu: {
        buildFromTemplate: template => ({ template }),
        setApplicationMenu: () => {},
      },
    };

    const mainModulePath = require.resolve('../../main');
    delete require.cache[mainModulePath];

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return mockElectron;
      }

      if (parent && parent.filename === mainModulePath && request === './src/gateway/db') {
        return {
          getDb: () => fakeDb,
          closeDb: () => {},
        };
      }

      if (parent && parent.filename === mainModulePath && request === './src/gateway/server') {
        return {
          GatewayServer: FakeGatewayServer,
        };
      }

      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      require('../../main');

      const userDataPath = mockApp.getPath('userData');
      await waitUntil(() => (
        browserWindows.length === 1 &&
        registeredHandlers.has('check-for-updates') &&
        registeredHandlers.has('get-current-login') &&
        fs.existsSync(path.join(userDataPath, 'windsurf-app-config.json')) &&
        fs.existsSync(path.join(userDataPath, 'accounts.json'))
      ));

      assert.equal(browserWindows.length, 1);
      assert.ok(registeredHandlers.has('check-for-updates'));
      assert.ok(registeredHandlers.has('get-current-login'));
      assert.ok(registeredHandlers.has('detect-windsurf-paths'));
      assert.ok(fs.existsSync(path.join(userDataPath, 'windsurf-app-config.json')));
      assert.ok(fs.existsSync(path.join(userDataPath, 'accounts.json')));
    } finally {
      Module._load = originalLoad;
      delete require.cache[mainModulePath];
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
