---
phase: 03-registration-pipeline
type: context
---

# Phase 3: Registration Pipeline — Context

## Goal
Batch registration auto-adds accounts to pool, registration status visible in real-time, failed accounts auto-retry.

## Key Integration Point
`src/main/ipc/registration.js` has a `saveAccountCallback` that saves to accounts.json.
After a successful save, we also need to insert into `pool_accounts` via `poolService.add()`.

## Decisions
- **Auto-add to pool**: After saveAccountCallback succeeds, call poolService.add() with source='registration'
- **Duplicate handling**: Check pool for existing email before adding (prevent double-add)
- **Retry tracking**: Store failed registrations in a simple JSON file, provide IPC handlers for retry
- **Status visibility**: Pool cards already show source field; add visual indicator for registration-source accounts
- **No new DB tables**: Use existing pool_accounts with source='registration' to identify auto-registered accounts

## Dependencies
- Phase 2 complete (PoolService, pool IPC handlers, pool UI exist)
