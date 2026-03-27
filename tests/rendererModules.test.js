const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

describe('Renderer module require chain', () => {
  it('accountRenderer exports windowExports object', () => {
    const mod = require('../src/renderer/accountRenderer');
    assert.ok(mod.windowExports, 'accountRenderer must export windowExports');
    assert.ok(typeof mod.windowExports === 'object');
  });

  it('registrationRenderer exports windowExports object', () => {
    const mod = require('../src/renderer/registrationRenderer');
    assert.ok(mod.windowExports, 'registrationRenderer must export windowExports');
    assert.ok(typeof mod.windowExports === 'object');
  });

  it('tokenRenderer exports windowExports object', () => {
    const mod = require('../src/renderer/tokenRenderer');
    assert.ok(mod.windowExports, 'tokenRenderer must export windowExports');
    assert.ok(typeof mod.windowExports === 'object');
  });

  it('switchRenderer exports windowExports object', () => {
    const mod = require('../src/renderer/switchRenderer');
    assert.ok(mod.windowExports, 'switchRenderer must export windowExports');
    assert.ok(typeof mod.windowExports === 'object');
  });

  it('renderer.js has less than 200 lines', () => {
    const fs = require('fs');
    const content = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(lines < 200, `renderer.js has ${lines} lines, expected < 200`);
  });
});
