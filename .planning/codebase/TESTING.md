# Testing Patterns

**Analysis Date:** 2026-03-26

## Test Framework

**Runner:**
- Node.js built-in test runner: `node:test` (`tests/emailReceiver.test.js`, `tests/accountDateFilter.test.js`).

**Assertion library:**
- `node:assert/strict` (`assert.equal`, `assert.deepEqual`, `assert.match`, `assert.notStrictEqual`, `assert.throws` where used).

**Config:**
- No `jest.config.*`, `vitest.config.*`, or dedicated test config file detected; tests rely on Node defaults.

**Run commands:**
```bash
node --test tests/
```
```bash
node --test tests/emailReceiver.test.js
```
```bash
node --test tests/accountDateFilter.test.js
```

**Note:** `package.json` does not define a generic `npm test` script. The only test-related npm script is `test:switch-with-reset`, which runs an Electron script (`electron test-account-switch-with-reset.js`), not the `tests/*.test.js` suite.

## Test File Organization

**Location:**
- All automated unit tests live under `tests/` at the repository root (not co-located with source).

**Naming:**
- `*.test.js` (e.g. `tests/emailReceiver.test.js`, `tests/accountDateFilter.test.js`).

**Structure:**
```
tests/
├── accountDateFilter.test.js   # targets js/accountDateFilter.js
└── emailReceiver.test.js       # targets src/emailReceiver.js
```

## Test Structure

**Suite organization:**
- Flat `test('description', () => { ... })` declarations; no `describe()` nesting in current tests.

**Patterns:**
- Start with `const test = require('node:test');` and `const assert = require('node:assert/strict');`.
- Require the module under test with CommonJS paths relative to `tests/`:
  - `const EmailReceiver = require('../src/emailReceiver');`
  - `const { isCreatedToday, ... } = require('../js/accountDateFilter');`
- Many cases assert `typeof SomeExport === 'function'` before behavior checks (defensive documentation of the public surface).
- Section separators as comments in large files, e.g. `// ========== isKnownOtpSender ==========` in `tests/emailReceiver.test.js`.

**Example (actual pattern):**
```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

const EmailReceiver = require('../src/emailReceiver');

test('mergeCandidateMessageIds deduplicates and prioritizes newest uids', () => {
  assert.equal(typeof EmailReceiver.mergeCandidateMessageIds, 'function');
  assert.deepEqual(
    EmailReceiver.mergeCandidateMessageIds([4, 7], [5, 6, 7, 8], 3),
    [8, 7, 6, 4]
  );
});
```

## Mocking

**Framework:** None in use (no `sinon`, `jest.mock`, `node:test` mocks, or similar in `tests/`).

**Patterns:**
- Tests call **pure functions** and **static methods** attached to `EmailReceiver` with literal inputs. No IMAP, `mailparser`, or network stubs in the suite.

**What to mock (guidance for new tests):**
- If adding integration tests around IMAP or Puppeteer, introduce isolation at the boundary (fake clients or dependency injection) consistent with how `EmailReceiver` is constructed in `src/emailReceiver.js`; the current suite does not establish a mocking convention.

**What not to mock:**
- Keep testing extracted pure logic the same way: fixed strings, dates, and small objects (`processedEmails: new Set()`, config objects).

## Fixtures and Factories

**Test data:**
- Inline object literals and string fixtures inside each `test()` block (e.g. mailbox header objects in `tests/emailReceiver.test.js`, account arrays in `tests/accountDateFilter.test.js`).

**Location:**
- No shared `fixtures/` or factory helpers detected.

## Coverage

**Requirements:** None enforced in `package.json` or CI config observed in this pass.

**View coverage (if added later):**
```bash
node --test --experimental-test-coverage tests/
```
(Node version must support the flag; adjust per installed Node.)

## Test Types

**Unit tests:**
- Present for email verification helpers, sequence/range math, and account date filtering — all synchronous or simple async-free logic.

**Integration tests:**
- Not present under `tests/` for Electron IPC, gateway HTTP, or database.

**E2E / manual:**
- `npm run test:switch-with-reset` drives Electron for account-switch scenarios; treat as separate from `node --test` unit tests.

## Common Patterns

**Async testing:**
- Not used in existing `tests/*.test.js` files; for future async tests, use `test('name', async (t) => { ... })` and assert on resolved values or use `assert.rejects` from `node:assert/strict`.

**Regex and string expectations:**
- `assert.match(string, /pattern/)` for debug strings and summaries (`tests/emailReceiver.test.js`).

**Equality:**
- Use `assert.deepEqual` for arrays and objects; `assert.notStrictEqual` when expecting a copied array reference (`tests/accountDateFilter.test.js` `filterAccountsByScope` shallow copy test).

**Time-dependent logic:**
- Pass fixed `Date` or numeric `now` into functions that accept time parameters (e.g. `isCreatedToday(..., now)`, `classifyVerificationEmail({ ..., now: ... })`) to keep tests deterministic.

---

*Testing analysis: 2026-03-26*
