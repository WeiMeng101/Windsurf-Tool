# 06-01 SUMMARY: Error Recovery Service

## Status: COMPLETE

## What changed
- `src/services/errorRecoveryService.js` now classifies pool account failures into cooldown, auth refresh, immediate retry, disable, and unknown-cooldown strategies instead of treating all errors the same way.
- Cooldown accounts are only released after `cooldown_until` passes; quota and unknown failures are pushed into cooldown with a computed deadline.
- Auth failures now use a dedicated refresh-attempt path, timeout failures retry immediately, and banned accounts are disabled through the pool status machine.
- Recovery results now return structured buckets: `recovered`, `disabled`, `cooldowns`, `skipped`, plus a compact `summary`.

## Evidence
- `classifyError()` now returns both `type` and `strategy`.
- Helper methods exist for `cooldownRelease`, `refreshTokens`, `putOnCooldown`, `retryImmediately`, and `disableAccount`.
- `scanAndRecover()` deduplicates accounts, respects active cooldown windows, and emits a summarized result object for the pool UI.

## Verification
- `node --check src/services/errorRecoveryService.js`
- `node -e "const svc=require('./src/services/errorRecoveryService'); console.log(typeof svc)"`
- `rg -n "strategy: 'cooldown'|strategy: 'refresh'|strategy: 'retry'|strategy: 'disable'|summary:" src/services/errorRecoveryService.js`
