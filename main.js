const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// 共享状态对象（传递给 IPC handler 模块）
const state = {
  isForceUpdateActive: false,
  isMaintenanceModeActive: false,
  isApiUnavailable: false,
  gatewayPort: 8090,
};
let versionCheckInterval = null;

// 修复 asar 中 ESM 模块动态导入问题
// 将解压的 node_modules 添加到模块搜索路径
const Module = require('module');

// 计算 asar.unpacked 的路径
const isPackaged = __dirname.includes('app.asar');
const unpackedNodeModules = isPackaged 
  ? path.join(__dirname, '..', 'app.asar.unpacked', 'node_modules')
  : path.join(__dirname, 'node_modules');

// 将解压的 node_modules 添加到全局模块路径（最高优先级）
if (isPackaged && !Module.globalPaths.includes(unpackedNodeModules)) {
  Module.globalPaths.unshift(unpackedNodeModules);
}

// 同时修改 NODE_PATH 环境变量，影响 ESM 导入
if (isPackaged) {
  const currentNodePath = process.env.NODE_PATH || '';
  process.env.NODE_PATH = unpackedNodeModules + path.delimiter + currentNodePath;
  Module._initPaths();
}

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  // 如果是 chrome-launcher 相关的导入，尝试从 asar.unpacked 加载
  if (request === 'chrome-launcher' || request.startsWith('chrome-launcher/')) {
    const unpackedPath = path.join(unpackedNodeModules, request);
    try {
      return originalResolveFilename.call(this, unpackedPath, parent, isMain, options);
    } catch (e) {
      // 如果失败，继续使用原始解析
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const accountsFileLock = require('./src/accountsFileLock');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// 处理 EPIPE 错误（管道关闭时的写入错误）
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});

let mainWindow;

// 应用名称 - 必须设置为 'Windsurf' 以使用相同的 Keychain 密钥
app.setName('Windsurf');

// 设置独立的用户数据目录（不与 Windsurf 共享）
// 注意：必须在复制 Local State 之前设置，确保路径一致
const appDataPath = app.getPath('appData');
const toolUserData = path.join(appDataPath, 'windsurf-tool');
app.setPath('userData', toolUserData);

// Windows: 复制 Windsurf 的 Local State 文件到工具目录
// 这样 safeStorage 才能正确加密/解密数据
if (process.platform === 'win32') {
  const windsurfUserData = path.join(appDataPath, 'Windsurf');
  const windsurfLocalState = path.join(windsurfUserData, 'Local State');
  const toolLocalState = path.join(toolUserData, 'Local State');
  
  try {
    const fsSync = require('fs');
    if (!fsSync.existsSync(toolUserData)) {
      fsSync.mkdirSync(toolUserData, { recursive: true });
    }
    
    if (fsSync.existsSync(windsurfLocalState)) {
      const shouldCopy = !fsSync.existsSync(toolLocalState) || 
                        fsSync.statSync(windsurfLocalState).mtimeMs > fsSync.statSync(toolLocalState).mtimeMs;
      
      if (shouldCopy) {
        fsSync.copyFileSync(windsurfLocalState, toolLocalState);
        console.log('[初始化] 已复制 Windsurf Local State 到工具目录');
        console.log(`[初始化]    源: ${windsurfLocalState}`);
        console.log(`[初始化]    目标: ${toolLocalState}`);
      } else {
        console.log('[初始化]   Local State 已是最新，无需复制');
      }
    } else {
      console.warn('[初始化] 未找到 Windsurf Local State，加密可能失败');
      console.warn(`[初始化]    期望路径: ${windsurfLocalState}`);
      console.warn('[初始化]    请确保 Windsurf 已安装并至少运行过一次');
    }
  } catch (error) {
    console.error('[初始化] 复制 Local State 失败:', error.message);
  }
}

// 跨平台安全路径获取函数
function getSafePath(base, ...paths) {
  return path.join(base, ...paths);
}

// 应用配置路径
const userDataPath = app.getPath('userData');
const ACCOUNTS_FILE = getSafePath(userDataPath, 'accounts.json');


function createWindow() {
  console.log('开始创建主窗口...');
  console.log('平台:', process.platform);
  console.log('架构:', process.arch);
  console.log('Electron版本:', process.versions.electron);
  console.log('Node版本:', process.versions.node);
  
  const isWin = process.platform === 'win32';
  const isMacOS = process.platform === 'darwin';
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: !app.isPackaged, // 生产环境禁用开发者工具
      webviewTag: true,
      webSecurity: false, // 允许加载本地资源
      allowRunningInsecureContent: true // 允许运行不安全的内容（开发环境）
    },
    title: '大魏注册',
    show: false, // 先不显示，等加载完成
    autoHideMenuBar: !isMacOS // Windows/Linux 自动隐藏菜单栏，按 Alt 显示
    // 注意：移除了 Windows titleBarStyle: 'hidden' 配置，恢复原生标题栏以支持拖拽
  });
  
  console.log('主窗口创建成功');

  // 加载完成后显示窗口
  mainWindow.once('ready-to-show', () => {
    console.log('窗口准备就绪，开始显示');
    mainWindow.show();
  });

  // 监听渲染进程崩溃
  mainWindow.webContents.on('crashed', () => {
    console.error('渲染进程崩溃');
    console.error('平台:', process.platform);
    console.error('时间:', new Date().toISOString());
    dialog.showErrorBox('应用崩溃', '渲染进程崩溃，请重启应用\n\n平台: ' + process.platform + '\n时间: ' + new Date().toLocaleString());
  });

  // 监听加载失败
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('页面加载失败:', errorCode, errorDescription);
    console.error('平台:', process.platform);
    console.error('时间:', new Date().toISOString());
    
    // Windows特殊处理
    if (process.platform === 'win32') {
      console.error('🔧 Windows调试信息:');
      console.error('  - 用户数据路径:', app.getPath('userData'));
      console.error('  - 应用路径:', app.getAppPath());
      console.error('  - 是否打包:', app.isPackaged);
    }
  });
  
  // 监听开发者工具打开事件
  mainWindow.webContents.on('devtools-opened', () => {
    if (state.isForceUpdateActive || state.isMaintenanceModeActive || state.isApiUnavailable) {
      console.log('检测到开发者工具打开，强制关闭');
      mainWindow.webContents.closeDevTools();
      
      // 发送警告到渲染进程
      mainWindow.webContents.send('devtools-blocked', {
        reason: state.isForceUpdateActive ? '强制更新模式' : state.isMaintenanceModeActive ? '维护模式' : 'API 无法访问'
      });
    }
  });
  
  // 处理快捷键
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // 检测刷新快捷键：Cmd+R (macOS) 或 Ctrl+R (Windows/Linux) 或 F5
    const isRefreshKey = (
      (input.key === 'r' && (input.meta || input.control)) ||
      input.key === 'F5'
    );
    
    // 检测开发者工具快捷键
    const isDevToolsKey = (
      (input.key === 'i' && input.meta && input.alt) || // macOS: Cmd+Option+I
      (input.key === 'i' && input.control && input.shift) || // Windows: Ctrl+Shift+I
      input.key === 'F12'
    );
    
    // 强制更新/维护模式下阻止操作
    if (state.isForceUpdateActive || state.isMaintenanceModeActive || state.isApiUnavailable) {
      if (isRefreshKey || isDevToolsKey) {
        event.preventDefault();
        console.log('已阻止操作:', isRefreshKey ? '刷新' : '开发者工具');
        mainWindow.webContents.send('show-force-update-warning');
      }
    } else {
      // 正常模式下允许刷新
      if (isRefreshKey && input.type === 'keyDown') {
        event.preventDefault();
        mainWindow.webContents.reload();
        console.log('页面已刷新 (Cmd/Ctrl+R)');
      }
    }
  });

  // 直接加载主界面
  mainWindow.loadFile('index.html').catch(err => {
    console.error('加载HTML失败:', err);
    dialog.showErrorBox('加载失败', '无法加载应用界面: ' + err.message);
  });
  
  // 开发模式或打包后都打开开发工具（方便调试）
  if (process.argv.includes('--dev') || !app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
}


// 初始化配置文件
async function initializeConfigFiles() {
  try {
    const userDataPath = app.getPath('userData');
    const configFile = path.join(userDataPath, 'windsurf-app-config.json');
    
    // 检查配置文件是否存在
    try {
      await fs.access(configFile);
      console.log(`Windsurf配置文件已存在: ${configFile}`);
    } catch (error) {
      // 文件不存在，创建默认配置
      console.log(` 创建默认Windsurf配置文件: ${configFile}`);
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      
      // 默认配置
      const defaultConfig = {
        emailDomains: ['example.com'],
        emailConfig: null,
        lastUpdate: new Date().toISOString(),
        platform: process.platform
      };
      
      // 写入默认配置
      await fs.writeFile(configFile, JSON.stringify(defaultConfig, null, 2));
      console.log(`默认Windsurf配置文件已创建`);
    }
    
    // 初始化其他必要的文件
    const accountsFile = path.join(userDataPath, 'accounts.json');
    try {
      await fs.access(accountsFile);
      console.log(`账号文件已存在: ${accountsFile}`);
      
      // 验证文件内容是否有效
      try {
        const data = await fs.readFile(accountsFile, 'utf-8');
        const accounts = JSON.parse(data);
        if (!Array.isArray(accounts)) {
          console.warn('账号文件格式错误，修复为空数组');
          await fs.writeFile(accountsFile, JSON.stringify([], null, 2));
        } else {
          console.log(`账号文件包含 ${accounts.length} 个账号`);
        }
      } catch (parseError) {
        console.warn('账号文件解析失败，修复为空数组');
        await fs.writeFile(accountsFile, JSON.stringify([], null, 2));
      }
    } catch (error) {
      // 创建空的账号文件（仅当文件不存在时）
      console.log(` 账号文件不存在，创建空文件: ${accountsFile}`);
      await fs.mkdir(path.dirname(accountsFile), { recursive: true });
      await fs.writeFile(accountsFile, JSON.stringify([], null, 2));
      console.log(`空的账号文件已创建`);
    }
  } catch (error) {
    console.error(`❗ 初始化配置文件失败:`, error);
  }
}

// 应用准备就绪时初始化配置并创建窗口
app.whenReady().then(async () => {
  await initializeConfigFiles();
  
  // 设置中文菜单（适配 macOS 和 Windows）
  const isMac = process.platform === 'darwin';
  
  const template = [
    // macOS 应用菜单
    ...(isMac ? [{
      label: '大魏注册',
      submenu: [
        { label: '关于 大魏注册', role: 'about' },
        { type: 'separator' },
        { label: '隐藏 大魏注册', role: 'hide', accelerator: 'Cmd+H' },
        { label: '隐藏其他', role: 'hideOthers', accelerator: 'Cmd+Option+H' },
        { label: '显示全部', role: 'unhide' },
        { type: 'separator' },
        { label: '退出 大魏注册', role: 'quit', accelerator: 'Cmd+Q' }
      ]
    }] : []),
    // Windows 文件菜单
    ...(!isMac ? [{
      label: '文件',
      submenu: [
        { label: '退出', role: 'quit', accelerator: 'Alt+F4' }
      ]
    }] : []),
    // 编辑菜单（支持复制、粘贴、全选等快捷键）
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo', accelerator: isMac ? 'Cmd+Z' : 'Ctrl+Z' },
        { label: '重做', role: 'redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y' },
        { type: 'separator' },
        { label: '剪切', role: 'cut', accelerator: isMac ? 'Cmd+X' : 'Ctrl+X' },
        { label: '复制', role: 'copy', accelerator: isMac ? 'Cmd+C' : 'Ctrl+C' },
        { label: '粘贴', role: 'paste', accelerator: isMac ? 'Cmd+V' : 'Ctrl+V' },
        { label: '全选', role: 'selectAll', accelerator: isMac ? 'Cmd+A' : 'Ctrl+A' }
      ]
    },
    // 功能菜单
    {
      label: '功能',
      submenu: [
        {
          label: '检查更新',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('check-for-updates');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'QQ群',
          click: () => shell.openExternal('https://qm.qq.com/q/1W3jvnDoak')
        },
        {
          label: 'GitHub',
          click: () => shell.openExternal('https://github.com/crispvibe/Windsurf-Tool')
        }
      ]
    }
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  
  createWindow();

  // 注册所有 IPC handlers
  const { registerAllHandlers } = require('./src/main/ipc');
  const AccountService = require('./src/services/accountService');
  const GatewayDataService = require('./src/services/gatewayDataService');
  const PoolService = require('./src/services/poolService');
  const { getDb } = require('./src/gateway/db');

  registerAllHandlers(mainWindow, {
    ACCOUNTS_FILE,
    accountsFileLock,
    accountService: new AccountService(ACCOUNTS_FILE),
    gatewayDataService: new GatewayDataService(getDb),
    getDb,
    poolService: new PoolService(getDb),
    userDataPath,
    appRoot: __dirname,
    state,
  });

  // 启动 API 网关服务
  try {
    const { GatewayServer } = require('./src/gateway/server');
    const gatewayServer = new GatewayServer({ port: 8090 });
    gatewayServer.start().then(() => {
      state.gatewayPort = gatewayServer.port;
      console.log(`[Gateway] API 网关服务已启动 http://127.0.0.1:${state.gatewayPort}`);
    }).catch(err => {
      console.error('[Gateway] API 网关启动失败:', err.message);
    });

    app.on('before-quit', () => {
      gatewayServer.stop().catch(() => {});
    });
  } catch (err) {
    console.error('[Gateway] 加载网关模块失败:', err.message);
  }

});

app.on('window-all-closed', () => {
  // 清理定时器
  if (versionCheckInterval) {
    clearInterval(versionCheckInterval);
  }
  
  // 清理所有 IPC 监听器
  ipcMain.removeAllListeners('check-version');
  ipcMain.removeAllListeners('set-force-update-status');
  ipcMain.removeAllListeners('quit-app');
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});


module.exports = {
  accountsFileLock
};
