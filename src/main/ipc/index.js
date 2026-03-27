/**
 * IPC Handler Aggregator
 * Registers all domain-specific IPC handlers.
 */
const accountHandlers = require('./account');
const registrationHandlers = require('./registration');
const codexHandlers = require('./codex');
const gatewayHandlers = require('./gateway');
const systemHandlers = require('./system');
const configHandlers = require('./config');
const poolHandlers = require('./pool');

/**
 * Register all IPC handlers.
 * @param {BrowserWindow} mainWindow - The main Electron window
 * @param {object} deps - Shared dependencies
 * @param {string} deps.ACCOUNTS_FILE - Path to accounts JSON file
 * @param {object} deps.accountsFileLock - File lock for accounts
 * @param {string} deps.userDataPath - app.getPath('userData')
 * @param {string} deps.appRoot - Project root directory (__dirname of main.js)
 * @param {object} deps.state - Shared mutable state
 * @param {AccountService} deps.accountService - Account data service
 * @param {GatewayDataService} deps.gatewayDataService - Gateway data service
 * @param {PoolService} deps.poolService - Pool account service
 */
function registerAllHandlers(mainWindow, deps) {
  accountHandlers.registerHandlers(mainWindow, deps);
  registrationHandlers.registerHandlers(mainWindow, deps);
  codexHandlers.registerHandlers(mainWindow, deps);
  gatewayHandlers.registerHandlers(mainWindow, deps);
  systemHandlers.registerHandlers(mainWindow, deps);
  configHandlers.registerHandlers(mainWindow, deps);
  poolHandlers.registerHandlers(mainWindow, deps);
}

module.exports = { registerAllHandlers };
