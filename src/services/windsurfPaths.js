// windsurfPaths.js - 统一的 Windsurf 路径检测服务
// 合并自 accountSwitcher.js (WindsurfPathDetector) 和 currentAccountDetector.js (getDBPath)
// 支持 Windows / macOS / Linux

'use strict';

const path = require('path');

let _app;
try {
  _app = require('electron').app;
} catch {
  // Electron 不可用
}

/**
 * 统一的 Windsurf 路径检测服务
 */
class WindsurfPathService {
  /**
   * 获取用户主目录（兼容 Electron 和 Node.js）
   */
  static getHomeDir() {
    try {
      if (_app && _app.getPath) {
        return _app.getPath('home');
      }
    } catch {
      // Electron 不可用
    }
    const os = require('os');
    return os.homedir();
  }

  /**
   * 获取 AppData / Application Support / .config 路径（兼容 Electron 和 Node.js）
   */
  static getAppDataDir() {
    try {
      if (_app && _app.getPath) {
        return _app.getPath('appData');
      }
    } catch {
      // Electron 不可用
    }
    const homeDir = this.getHomeDir();
    if (process.platform === 'win32') {
      return path.join(homeDir, 'AppData', 'Roaming');
    } else if (process.platform === 'darwin') {
      return path.join(homeDir, 'Library', 'Application Support');
    }
    return path.join(homeDir, '.config');
  }

  /**
   * 获取 Windsurf 用户数据目录
   */
  static getDataDir() {
    const platform = process.platform;
    if (platform === 'win32') {
      return path.join(this.getAppDataDir(), 'Windsurf');
    } else if (platform === 'darwin') {
      return path.join(this.getHomeDir(), 'Library', 'Application Support', 'Windsurf');
    } else if (platform === 'linux') {
      return path.join(this.getHomeDir(), '.config', 'Windsurf');
    }
    throw new Error(`不支持的平台: ${platform}`);
  }

  /**
   * 获取 state.vscdb 数据库路径
   */
  static getDBPath() {
    return path.join(this.getDataDir(), 'User', 'globalStorage', 'state.vscdb');
  }

  /**
   * 获取 Local State 路径
   */
  static getLocalStatePath() {
    return path.join(this.getDataDir(), 'Local State');
  }

  /**
   * 获取 storage.json 路径
   */
  static getStorageJsonPath() {
    return path.join(this.getDataDir(), 'User', 'globalStorage', 'storage.json');
  }

  /**
   * 获取 Windsurf 可执行文件的默认路径
   */
  static getExecutablePath() {
    const platform = process.platform;
    if (platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(this.getHomeDir(), 'AppData', 'Local');
      return path.join(localAppData, 'Programs', 'Windsurf', 'Windsurf.exe');
    } else if (platform === 'darwin') {
      return '/Applications/Windsurf.app';
    } else if (platform === 'linux') {
      return '/usr/bin/windsurf';
    }
    throw new Error(`不支持的平台: ${platform}`);
  }

  /**
   * 获取扩展目录
   */
  static getExtensionsDir() {
    return path.join(this.getHomeDir(), '.windsurf', 'extensions');
  }

  /**
   * 获取所有相关路径
   */
  static getAllPaths() {
    return {
      dataDir: this.getDataDir(),
      dbPath: this.getDBPath(),
      localStatePath: this.getLocalStatePath(),
      storageJsonPath: this.getStorageJsonPath(),
      executablePath: this.getExecutablePath(),
      extensionsDir: this.getExtensionsDir(),
    };
  }
}

module.exports = { WindsurfPathService };
