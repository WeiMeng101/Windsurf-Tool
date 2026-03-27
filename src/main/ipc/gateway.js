/**
 * Gateway IPC Handlers
 */
const { ipcMain } = require('electron');

function registerHandlers(mainWindow, deps) {
  const { state } = deps;

  ipcMain.handle('get-gateway-port', () => state.gatewayPort);
}

module.exports = { registerHandlers };
