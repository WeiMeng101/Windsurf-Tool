/**
 * Configuration IPC Handlers
 */
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;

function registerHandlers(mainWindow, deps) {
  const { userDataPath, accountService } = deps;

  // 获取配置文件路径
  ipcMain.handle('get-config-path', async () => {
    try {
      const configFile = path.join(userDataPath, 'windsurf-app-config.json');
      return { success: true, path: configFile };
    } catch (error) {
      console.error('获取配置路径失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 保存Windsurf配置
  ipcMain.handle('save-windsurf-config', async (event, config) => {
    try {
      const configFile = path.join(userDataPath, 'windsurf-app-config.json');
      
      // 确保目录存在
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      
      // 保存配置到文件
      await accountService.writeFileRaw(configFile, JSON.stringify(config, null, 2));

      console.log(`Windsurf配置已保存 (${process.platform}):`, configFile);
      return { success: true, message: '配置已保存' };
    } catch (error) {
      console.error(`保存Windsurf配置失败 (${process.platform}):`, error);
      return { success: false, error: error.message };
    }
  });

  // 读取Windsurf配置
  ipcMain.handle('load-windsurf-config', async (event) => {
    try {
      const configFile = path.join(userDataPath, 'windsurf-app-config.json');
      
      try {
        const data = await accountService.readFileRaw(configFile);
        const config = JSON.parse(data);
        console.log(`Windsurf配置已读取 (${process.platform}):`, configFile);
        // 返回统一格式：{ success: true, config: ... }
        return { success: true, config };
      } catch (error) {
        // 文件不存在或解析失败，返回默认配置
        console.log(`  Windsurf配置文件不存在或无法读取 (${process.platform})，使用默认配置`);
        console.log(`   预期路径: ${configFile}`);
        return {
          success: true,
          config: {
            emailDomains: ['example.com'],
            emailConfig: null,
            passwordMode: 'email'
          }
        };
      }
    } catch (error) {
      console.error(`读取Windsurf配置失败 (${process.platform}):`, error);
      return { success: false, error: error.message };
    }
  });

  // 保存 Codex 配置
  ipcMain.handle('save-codex-config', async (event, config) => {
    try {
      const configFile = path.join(userDataPath, 'codex-config.json');
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      await accountService.writeFileRaw(configFile, JSON.stringify(config, null, 2));
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 加载 Codex 配置
  ipcMain.handle('load-codex-config', async () => {
    try {
      const configFile = path.join(userDataPath, 'codex-config.json');
      const data = await accountService.readFileRaw(configFile);
      return { success: true, config: JSON.parse(data) };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { success: true, config: { proxy: '', enableOAuth: true } };
      }
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerHandlers };
