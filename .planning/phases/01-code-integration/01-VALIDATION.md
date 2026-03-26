---
phase: 1
slug: code-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-27
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test (Node.js built-in) + node:assert/strict |
| **Config file** | none — zero config test runner |
| **Quick run command** | `node --test tests/<file>.test.js` |
| **Full suite command** | `node --test tests/*.test.js` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `node --test tests/*.test.js`
- **After every plan wave:** Run `node --test tests/*.test.js` + manual app launch verification
- **Before `/gsd:verify-work`:** Full suite must be green + app launch verified
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | INTG-02 | unit | `node --test tests/accountService.test.js` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | INTG-02 | unit | `node --test tests/gatewayDataService.test.js` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 1 | INTG-01 | unit | `node --test tests/rendererModules.test.js` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 2 | INTG-01 | smoke | `wc -l renderer.js` (verify < 200) | ❌ W0 | ⬜ pending |
| 01-03-02 | 03 | 2 | INTG-01 | smoke | `ls js/` (verify empty) | ❌ W0 | ⬜ pending |
| 01-03-03 | 03 | 2 | INTG-01 | smoke | `ls ui/` (verify empty) | ❌ W0 | ⬜ pending |
| 01-03-04 | 03 | 2 | INTG-01 | smoke | `grep -c '<script' index.html` (verify <= 3) | ❌ W0 | ⬜ pending |
| 01-03-05 | 03 | 2 | INTG-02 | grep audit | `grep -r "readFile.*accounts" src/main/ipc/` should return 0 | N/A | ⬜ pending |
| 01-03-06 | 03 | 2 | INTG-02 | grep audit | `grep -r "getDb()" src/main/ipc/ src/services/` should return 0 outside service | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/accountService.test.js` — stubs for INTG-02 account service
- [ ] `tests/gatewayDataService.test.js` — stubs for INTG-02 gateway data service
- [ ] `tests/rendererModules.test.js` — stubs for INTG-01 module require chain
- [ ] `tests/smokeStructure.test.js` — stubs for INTG-01 directory/file structure checks
- [ ] Framework install: none needed — `node:test` is built-in

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| App launches after each migration step | INTG-01, INTG-02 | Electron app requires GUI | Open app, verify main window renders |
| View switching works (tabs) | INTG-01 | DOM interaction | Click each tab, verify correct panel displays |
| Account list loads and displays | INTG-01, INTG-02 | End-to-end data flow | Open account tab, verify accounts from accounts.json appear |
| Registration flow accessible | INTG-01 | DOM interaction | Open registration tab, verify form renders |
| Gateway management accessible | INTG-01 | DOM interaction | Open gateway tab, verify panel renders |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
