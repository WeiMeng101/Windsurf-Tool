// detectorRenderer.js - 检测当前 Windsurf 登录账号
// 独立模块，支持 Windows/Mac/Linux
// 从 js/currentAccountDetector.js 迁移

'use strict';

const path = require('path');
const fs = require('fs').promises;
const { WindsurfPathService } = require('../services/windsurfPaths');

/**
 * 当前账号检测器
 */
class CurrentAccountDetector {
  /**
   * 获取 Windsurf 数据库路径
   */
  static getDBPath() {
    if (!WindsurfPathService || !path) {
      throw new Error('此方法只能在 Node.js 环境中使用');
    }
    return WindsurfPathService.getDBPath();
  }

  /**
   * 检查 Windsurf 是否已安装
   */
  static async isInstalled() {
    try {
      const dbPath = this.getDBPath();
      await fs.access(dbPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从数据库读取当前登录的账号
   */
  static async getCurrentAccount() {
    try {
      // 检查是否已安装
      const isInstalled = await this.isInstalled();
      if (!isInstalled) {
        console.log('[账号检测] Windsurf 未安装');
        return null;
      }

      const initSqlJs = require('sql.js');
      const dbPath = this.getDBPath();

      // 读取数据库文件
      const dbBuffer = await fs.readFile(dbPath);

      // 初始化 sql.js
      const SQL = await initSqlJs();
      const db = new SQL.Database(dbBuffer);

      // 查询 windsurfAuthStatus
      const result = db.exec('SELECT value FROM ItemTable WHERE key = ?', ['windsurfAuthStatus']);
      db.close();

      if (result.length > 0 && result[0].values.length > 0) {
        const value = result[0].values[0][0];
        const accountData = JSON.parse(value);

        console.log('[账号检测] 当前登录账号:', accountData.email);

        return {
          email: accountData.email,
          name: accountData.name,
          apiKey: accountData.apiKey,
          planName: accountData.planName
        };
      }

      console.log('[账号检测] 未检测到登录账号');
      return null;

    } catch (error) {
      console.error('[账号检测] 检测失败:', error.message);
      return null;
    }
  }

  /**
   * 检查指定邮箱是否是当前登录账号
   */
  static async isCurrentAccount(email) {
    try {
      const currentAccount = await this.getCurrentAccount();

      if (!currentAccount) {
        return false;
      }

      // 邮箱匹配（不区分大小写）
      return currentAccount.email.toLowerCase() === email.toLowerCase();

    } catch (error) {
      console.error('[账号检测] 检查失败:', error);
      return false;
    }
  }
}

/**
 * 更新账号列表，标记当前使用的账号
 * 注意：此功能已禁用，仅保留头部账号检测
 */
async function updateAccountListWithCurrent() {
  // 功能已禁用 - 不再在列表中标记当前账号
  return;
}

/**
 * 定时检测当前账号（可选）
 * 注意：此功能已禁用
 */
function startCurrentAccountMonitor(interval = 10000) {
  // 功能已禁用
  return;
}

/**
 * 获取当前账号（供外部调用）
 */
async function getCurrentAccount() {
  return CurrentAccountDetector.getCurrentAccount();
}

/**
 * 刷新当前账号显示
 */
async function refreshCurrentAccount() {
  const account = await CurrentAccountDetector.getCurrentAccount();
  const el = document.getElementById('currentAccountEmail');
  if (el) {
    el.textContent = account ? account.email : '未检测到';
  }
  return account;
}

// ==================== Module exports ====================

module.exports = {
  CurrentAccountDetector,
  windowExports: {
    CurrentAccountDetector,
    updateAccountListWithCurrent,
    startCurrentAccountMonitor,
    getCurrentAccount,
    refreshCurrentAccount,
  },
};
