# 03-01 SUMMARY: Registration → Pool Auto-Integration

## Status: COMPLETE

## What was done
- Modified `src/main/ipc/registration.js` saveAccountCallback to auto-add registered accounts to pool
- After successful save to accounts.json, calls `poolService.add()` with source='registration'
- Duplicate check: skips pool add if email already exists in pool
- Error handling: pool add failure doesn't affect registration success
- Added "注册" source badge to pool cards in poolRenderer.js

## Files modified
- `src/main/ipc/registration.js` — pool auto-add logic in saveAccountCallback
- `src/renderer/poolRenderer.js` — source badge on registration-sourced cards

## Verification
- grep -c "poolService" src/main/ipc/registration.js → 4
- grep -c "source.*registration" src/renderer/poolRenderer.js → 1
- 106/106 tests passing, no regressions
