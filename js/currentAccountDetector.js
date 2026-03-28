'use strict';

const { CurrentAccountDetector, windowExports } = require('../src/renderer/detectorRenderer');

async function getCurrentAccount() {
  return CurrentAccountDetector.getCurrentAccount();
}

module.exports = {
  ...CurrentAccountDetector,
  CurrentAccountDetector,
  getCurrentAccount,
  windowExports,
};
