'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

function createElement(id = null) {
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    disabled: false,
    className: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    appendChild() {},
    insertAdjacentHTML() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    remove() {},
    select() {},
    contains() { return false; },
  };
}

function waitForTick() {
  return new Promise(resolve => setImmediate(resolve));
}

describe('Renderer bootstrap smoke', () => {
  it('loads renderer.js and wires globals without a browser crash', async () => {
    const rendererModulePath = require.resolve('../../renderer');
    delete require.cache[rendererModulePath];

    const originalLoad = Module._load;
    const originalWindow = global.window;
    const originalDocument = global.document;
    const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
    const originalLocalStorage = global.localStorage;
    const originalLucide = global.lucide;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    const ipcListeners = new Map();
    const windowListeners = new Map();
    const documentListeners = new Map();
    const elements = new Map();

    const document = {
      head: createElement('head'),
      body: createElement('body'),
      createElement(tagName) {
        return createElement(tagName);
      },
      getElementById(id) {
        if (!elements.has(id)) {
          if (id === 'fadeOutStyle') return null;
          elements.set(id, createElement(id));
        }
        return elements.get(id);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener(event, handler) {
        documentListeners.set(event, handler);
      },
      removeEventListener(event) {
        documentListeners.delete(event);
      },
      execCommand() {
        return true;
      },
    };
    document.head.appendChild = element => {
      if (element?.id) elements.set(element.id, element);
    };
    document.body.appendChild = () => {};
    document.body.insertAdjacentHTML = () => {};

    const mockElectron = {
      ipcRenderer: {
        on(channel, handler) {
          ipcListeners.set(channel, handler);
        },
        async invoke(channel) {
          if (channel === 'load-windsurf-config') {
            return { success: true, config: { emailDomains: ['example.com'], emailConfig: null, passwordMode: 'email' } };
          }
          if (channel === 'get-accounts') {
            return { success: true, accounts: [] };
          }
          if (channel === 'get-config-path') {
            return { success: true, path: path.join(process.cwd(), 'tmp-config.json') };
          }
          if (channel === 'get-file-paths') {
            return {
              success: true,
              paths: {
                userDataPath: '/tmp',
                configFile: '/tmp/windsurf-app-config.json',
                accountsFile: '/tmp/accounts.json',
                platform: process.platform,
              },
            };
          }
          if (channel === 'check-for-updates') {
            return { success: true, hasUpdate: false, currentVersion: '6.4.1', latestVersion: '6.4.1' };
          }
          return { success: true };
        },
        send() {},
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
      },
      app: {
        getPath: () => '/tmp',
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from(''),
        decryptString: () => '',
      },
    };

    global.window = {
      document,
      addEventListener(event, handler) {
        windowListeners.set(event, handler);
      },
      removeEventListener(event) {
        windowListeners.delete(event);
      },
      showCustomAlert() {},
      showToast() {},
      showCustomConfirm: async () => false,
      loadAccounts: async () => {},
      navigator: {
        clipboard: {
          writeText: async () => {},
        },
      },
    };
    global.document = document;
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      writable: true,
      value: global.window.navigator,
    });
    global.localStorage = {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    };
    global.lucide = {
      icons: {},
      createIcons() {},
    };
    global.setInterval = () => 1;
    global.clearInterval = () => {};

    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return mockElectron;
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      require('../../renderer');

      assert.equal(typeof window.safeIpcInvoke, 'function');
      assert.equal(typeof window.switchView, 'function');
      assert.equal(typeof window.openConfigFolder, 'function');
      assert.ok(windowListeners.has('DOMContentLoaded'));
      assert.ok(windowListeners.has('error'));
      assert.ok(windowListeners.has('unhandledrejection'));
      assert.ok(documentListeners.has('click'));
      assert.ok(ipcListeners.has('check-for-updates'));
      assert.ok(ipcListeners.has('version-update-available'));
      assert.ok(ipcListeners.has('maintenance-mode-active'));
      assert.ok(ipcListeners.has('batch-token-progress'));
      assert.ok(ipcListeners.has('registration-progress'));
    } finally {
      windowListeners.get('beforeunload')?.();
      Module._load = originalLoad;
      delete require.cache[rendererModulePath];
      global.window = originalWindow;
      global.document = originalDocument;
      if (originalNavigatorDescriptor) {
        Object.defineProperty(global, 'navigator', originalNavigatorDescriptor);
      } else {
        delete global.navigator;
      }
      global.localStorage = originalLocalStorage;
      global.lucide = originalLucide;
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });

  it('does not log auto-query failures if the renderer window goes away during shutdown', async () => {
    const rendererModulePath = require.resolve('../../renderer');
    delete require.cache[rendererModulePath];

    const originalLoad = Module._load;
    const originalWindow = global.window;
    const originalDocument = global.document;
    const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
    const originalLocalStorage = global.localStorage;
    const originalLucide = global.lucide;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalConsoleError = console.error;

    const windowListeners = new Map();
    const documentListeners = new Map();
    const elements = new Map();
    const errorLogs = [];

    const document = {
      head: createElement('head'),
      body: createElement('body'),
      createElement(tagName) {
        return createElement(tagName);
      },
      getElementById(id) {
        if (!elements.has(id)) {
          if (id === 'fadeOutStyle') return null;
          elements.set(id, createElement(id));
        }
        return elements.get(id);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener(event, handler) {
        documentListeners.set(event, handler);
      },
      removeEventListener(event) {
        documentListeners.delete(event);
      },
      execCommand() {
        return true;
      },
    };
    document.head.appendChild = element => {
      if (element?.id) elements.set(element.id, element);
    };
    document.body.appendChild = () => {};
    document.body.insertAdjacentHTML = () => {};

    const mockElectron = {
      ipcRenderer: {
        on() {},
        async invoke(channel) {
          if (channel === 'load-windsurf-config') {
            return { success: true, config: { emailDomains: ['example.com'], emailConfig: null, passwordMode: 'email' } };
          }
          if (channel === 'get-accounts') {
            return { success: true, accounts: [] };
          }
          if (channel === 'get-config-path') {
            return { success: true, path: path.join(process.cwd(), 'tmp-config.json') };
          }
          if (channel === 'get-file-paths') {
            return {
              success: true,
              paths: {
                userDataPath: '/tmp',
                configFile: '/tmp/windsurf-app-config.json',
                accountsFile: '/tmp/accounts.json',
                platform: process.platform,
              },
            };
          }
          if (channel === 'check-for-updates') {
            return { success: true, hasUpdate: false, currentVersion: '6.4.1', latestVersion: '6.4.1' };
          }
          return { success: true };
        },
        send() {},
      },
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
      },
      app: {
        getPath: () => '/tmp',
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from(''),
        decryptString: () => '',
      },
    };

    global.window = {
      document,
      addEventListener(event, handler) {
        windowListeners.set(event, handler);
      },
      removeEventListener(event) {
        windowListeners.delete(event);
      },
      showCustomAlert() {},
      showToast() {},
      showCustomConfirm: async () => false,
      loadAccounts: async () => {},
      navigator: {
        clipboard: {
          writeText: async () => {},
        },
      },
    };
    global.document = document;
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      writable: true,
      value: global.window.navigator,
    });
    global.localStorage = {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    };
    global.lucide = {
      icons: {},
      createIcons() {},
    };
    global.setInterval = () => 1;
    global.clearInterval = () => {};
    console.error = (...args) => {
      errorLogs.push(args.map(String).join(' '));
    };

    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return mockElectron;
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      require('../../renderer');

      delete global.window;
      await waitForTick();

      assert.deepEqual(
        errorLogs.filter(entry => entry.includes('[自动查询] 查询失败')),
        []
      );
    } finally {
      windowListeners.get('beforeunload')?.();
      Module._load = originalLoad;
      delete require.cache[rendererModulePath];
      console.error = originalConsoleError;
      global.window = originalWindow;
      global.document = originalDocument;
      if (originalNavigatorDescriptor) {
        Object.defineProperty(global, 'navigator', originalNavigatorDescriptor);
      } else {
        delete global.navigator;
      }
      global.localStorage = originalLocalStorage;
      global.lucide = originalLucide;
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });
});
