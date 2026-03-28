# 01-01 SUMMARY: Data Service Layer

## Status: COMPLETE

## What was done

### Task 1: Introduced service wrappers for account and gateway storage
- `src/services/accountService.js` now centralizes `accounts.json` reads, writes, CRUD helpers, and raw file access for adjacent config/backup operations.
- `src/services/gatewayDataService.js` now wraps gateway DB access behind `getDb()`, `query()`, `all()`, and `get()`.
- `main.js` injects both services into IPC registration so handlers consume services through `deps` instead of reaching into storage directly.

### Task 2: Moved IPC account persistence onto the service layer
- `src/main/ipc/account.js` uses `accountService` for account CRUD and now routes backup file reads/writes through the service as well.
- `src/main/ipc/config.js` uses `accountService.readFileRaw()` / `writeFileRaw()` for config persistence.
- `src/main/ipc/registration.js` no longer reads or writes `accounts.json` via direct `fs.readFile` / `fs.writeFile`; it now uses `accountService` inside the existing file lock flow.

## Verification
- `node --test tests/accountService.test.js tests/gatewayDataService.test.js`
- `rg -n "readFile\\(|writeFile\\(" src/main/ipc`
  Remaining matches are no longer direct account storage calls except system file utilities outside this plan's scope.
- `rg -n "accountService|gatewayDataService" main.js src/main/ipc`
