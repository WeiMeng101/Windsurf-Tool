/**
 * System IPC Handlers
 * Handles: force update, quit, external URLs, file paths, Windsurf detection, file dialogs
 */
const { app, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;

function registerHandlers(mainWindow, deps) {
  const { state, userDataPath } = deps;

  // 监听来自渲染进程的强制更新状态
  ipcMain.on('set-force-update-status', (event, status) => {
    state.isForceUpdateActive = status;
    console.log('强制更新状态:', status ? '激活' : '关闭');
    
    // 强制更新时禁用开发者工具
    if (status && app.isPackaged) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      }
    }
  });

  // 监听退出应用请求
  ipcMain.on('quit-app', () => {
    console.log('📢 收到退出应用请求');
    app.quit();
  });

  // 打开下载链接
  ipcMain.handle('open-download-url', async (event, downloadUrl) => {
    try {
      if (downloadUrl) {
        await shell.openExternal(downloadUrl);
        return { success: true };
      } else {
        // 如果没有下载链接，打开GitHub发布页面
        await shell.openExternal('https://github.com/crispvibe/Windsurf-Tool/releases/latest');
        return { success: true };
      }
    } catch (error) {
      console.error('打开下载链接失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 打开外部URL（通用）
  ipcMain.handle('open-external-url', async (event, url) => {
    try {
      if (url) {
        await shell.openExternal(url);
        return { success: true };
      } else {
        return { success: false, error: 'URL不能为空' };
      }
    } catch (error) {
      console.error('打开外部URL失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 获取用户数据路径
  ipcMain.handle('get-user-data-path', () => {
    try {
      return {
        success: true,
        path: app.getPath('userData')
      };
    } catch (error) {
      console.error('获取用户数据路径失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  // 获取配置文件和账号文件路径
  ipcMain.handle('get-file-paths', () => {
    try {
      const userDataPath = app.getPath('userData');
      const configFile = path.join(userDataPath, 'windsurf-app-config.json');
      const accountsFile = path.join(userDataPath, 'accounts.json');
      
      return {
        success: true,
        paths: {
          userDataPath: userDataPath,
          configFile: configFile,
          accountsFile: accountsFile,
          platform: process.platform
        }
      };
    } catch (error) {
      console.error('获取文件路径失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  // 检查维护模式
  ipcMain.handle('check-maintenance-mode', async () => {
    return {
      success: true,
      inMaintenance: !!state.isMaintenanceModeActive,
      maintenanceInfo: state.maintenanceInfo || {
        enabled: !!state.isMaintenanceModeActive,
        message: state.isMaintenanceModeActive ? '服务器正在维护中，请稍后再试' : '',
        timestamp: new Date().toISOString(),
      },
    };
  });

  // 退出维护模式
  ipcMain.handle('exit-maintenance-mode', async () => {
    state.isMaintenanceModeActive = false;
    state.maintenanceInfo = null;
    return { success: true };
  });

  // 检查更新
  ipcMain.handle('check-for-updates', async () => {
    try {
      const currentVersion = app.getVersion();
      return {
        success: true,
        hasUpdate: false,
        forceUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        downloadUrl: 'https://github.com/crispvibe/Windsurf-Tool/releases/latest',
        updateMessage: '',
      };
    } catch (error) {
      console.error('检查更新失败:', error);
      return {
        success: false,
        hasUpdate: false,
        forceUpdate: false,
        currentVersion: '0.0.0',
        latestVersion: '0.0.0',
        error: error.message,
      };
    }
  });

  // 检测 Windsurf 相关路径
  ipcMain.handle('detect-windsurf-paths', async () => {
    try {
      const { WindsurfPathService } = require(path.join(deps.appRoot, 'js', 'accountSwitcher'));
      const allPaths = WindsurfPathService.getAllPaths();
      const entries = await Promise.all(
        Object.entries(allPaths).map(async ([key, targetPath]) => {
          try {
            await fs.access(targetPath);
            return [key, { path: targetPath, exists: true }];
          } catch {
            return [key, { path: targetPath, exists: false }];
          }
        })
      );

      return Object.fromEntries(entries);
    } catch (error) {
      console.error('检测 Windsurf 路径失败:', error);
      return {
        error: { path: '', exists: false, message: error.message },
      };
    }
  });

  // 获取当前机器标识
  ipcMain.handle('get-machine-id', async () => {
    try {
      const { WindsurfPathService } = require(path.join(deps.appRoot, 'js', 'accountSwitcher'));
      const machineIdPath = path.join(WindsurfPathService.getDataDir(), 'machineid');
      const storageJsonPath = WindsurfPathService.getStorageJsonPath();

      const [machineId, storageJsonRaw] = await Promise.all([
        fs.readFile(machineIdPath, 'utf8'),
        fs.readFile(storageJsonPath, 'utf8'),
      ]);

      const storageJson = JSON.parse(storageJsonRaw);

      return {
        success: true,
        machineId: machineId.trim(),
        sqmId: storageJson['telemetry.sqmId'] || '',
        devDeviceId: storageJson['telemetry.devDeviceId'] || '',
        telemetryMachineId: storageJson['telemetry.machineId'] || '',
      };
    } catch (error) {
      console.error('获取机器标识失败:', error);
      return {
        success: false,
        machineId: '未安装或未配置',
        error: error.message,
      };
    }
  });

  // 打开配置目录
  ipcMain.handle('open-config-folder', async () => {
    try {
      const openedPath = await shell.openPath(userDataPath);
      if (openedPath) {
        throw new Error(openedPath);
      }
      return { success: true, path: userDataPath };
    } catch (error) {
      console.error('打开配置目录失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 检测 Windsurf 是否正在运行
  ipcMain.handle('check-windsurf-running', async () => {
    try {
      const { WindsurfPathDetector } = require(path.join(deps.appRoot, 'js', 'accountSwitcher'));
      return await WindsurfPathDetector.isRunning();
    } catch (error) {
      console.error('检测 Windsurf 运行状态失败:', error);
      return false;
    }
  });

  // 关闭 Windsurf
  ipcMain.handle('close-windsurf', async () => {
    try {
      const { WindsurfPathDetector } = require(path.join(deps.appRoot, 'js', 'accountSwitcher'));
      await WindsurfPathDetector.closeWindsurf();
      return { success: true };
    } catch (error) {
      console.error('关闭 Windsurf 失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 保存文件对话框 - 用于导出功能
  ipcMain.handle('save-file-dialog', async (event, options) => {
    try {
      const { content, title, defaultPath, filters } = options;
      
      // 显示保存对话框
      const result = await dialog.showSaveDialog(mainWindow, {
        title: title || '保存文件',
        defaultPath: defaultPath || path.join(app.getPath('documents'), 'export.txt'),
        filters: filters || [{ name: '所有文件', extensions: ['*'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });
      
      if (result.canceled) {
        return { success: false, cancelled: true };
      }
      
      // 写入文件
      const normalizedPath = path.normalize(result.filePath);
      const dir = path.dirname(normalizedPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(normalizedPath, content, { encoding: 'utf-8', flag: 'w' });
      
      console.log(`文件已保存: ${normalizedPath}`);
      
      return { 
        success: true, 
        filePath: normalizedPath
      };
    } catch (error) {
      console.error('保存文件失败:', error);
      return { 
        success: false, 
        error: error.message 
      };
    }
  });

  // 保存文件 - 跨平台兼容
  ipcMain.handle('save-file', async (event, options) => {
    try {
      const { content, filename, filters } = options;
      
      // 规范化文件名，移除不合法字符
      const sanitizedFilename = filename.replace(/[<>:"\/\\|?*]/g, '_');
      
      // 设置默认保存路径（使用用户主目录）
      const defaultPath = path.join(
        app.getPath('documents'),
        sanitizedFilename
      );
      
      // 显示保存对话框
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultPath,
        filters: filters || [
          { name: '所有文件', extensions: ['*'] }
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });
      
      if (result.canceled) {
        return { success: false, error: '用户取消了保存操作' };
      }
      
      // 规范化路径（跨平台兼容）
      const normalizedPath = path.normalize(result.filePath);
      
      // 确保目录存在
      const dir = path.dirname(normalizedPath);
      await fs.mkdir(dir, { recursive: true });
      
      // 写入文件（使用 UTF-8 编码，兼容 Windows 和 macOS）
      await fs.writeFile(normalizedPath, content, { encoding: 'utf-8', flag: 'w' });
      
      console.log(`文件已保存: ${normalizedPath}`);
      
      return { 
        success: true, 
        filePath: normalizedPath,
        message: '文件保存成功'
      };
    } catch (error) {
      console.error('保存文件失败:', error);
      return { 
        success: false, 
        error: `保存失败: ${error.message}` 
      };
    }
  });
}

module.exports = { registerHandlers };
