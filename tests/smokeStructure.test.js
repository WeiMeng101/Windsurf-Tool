const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Phase 1 structure smoke tests', () => {
  it('js/ directory contains only legacy compatibility shims', () => {
    const jsDir = path.join(__dirname, '..', 'js');
    assert.ok(fs.existsSync(jsDir), 'js/ compatibility directory should exist');

    const files = fs.readdirSync(jsDir).filter(f => !f.startsWith('.')).sort();
    assert.deepEqual(files, [
      'accountLogin.js',
      'accountQuery.js',
      'accountSwitcher.js',
      'codexAccountSwitcher.js',
      'constants.js',
      'currentAccountDetector.js',
    ]);
  });

  it('ui/ directory is empty or does not exist', () => {
    const uiDir = path.join(__dirname, '..', 'ui');
    if (fs.existsSync(uiDir)) {
      const files = fs.readdirSync(uiDir).filter(f => !f.startsWith('.'));
      assert.strictEqual(files.length, 0, `ui/ should be empty but contains: ${files.join(', ')}`);
    }
  });

  it('index.html has <= 3 script tags', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
    const scriptMatches = html.match(/<script[^>]*>/g) || [];
    assert.ok(scriptMatches.length <= 3, `index.html has ${scriptMatches.length} script tags, expected <= 3`);
  });

  it('renderer.js has < 200 lines', () => {
    const content = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(lines < 200, `renderer.js has ${lines} lines, expected < 200`);
  });
});
