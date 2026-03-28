# 07-01 SUMMARY: Global Dashboard

## Status: COMPLETE

## What changed
- `index.html` now promotes “全局概览” to the default landing view and updates the sidebar/footer copy so the app opens on the dashboard instead of the account center.
- `src/renderer/dashboardRenderer.js` now renders three concrete sections: pool overview, gateway status, and recent error accounts.
- The dashboard no longer only shows the gateway port. It now checks the local gateway `/health`, reads `/api/admin/channels`, and surfaces total/enabled channel counts alongside pool health.
- `css/views/dashboard.css` provides the dedicated layout and responsive styling for the dashboard cards, status badge, and recent-error list.

## Evidence
- Dashboard is the active nav item and active view in `index.html`.
- `DashboardManager` fetches pool accounts via `pool-get-accounts`, gateway port via `get-gateway-port`, and then probes gateway health/channel data over HTTP.
- The dashboard renders empty/loading states as well as recent error metadata timestamps.

## Verification
- `node --check src/renderer/dashboardRenderer.js`
- `rg -n "data-view=\"dashboard\"|dashboard-content|dashboard-loading|fetchJson|enabledChannels" index.html src/renderer/dashboardRenderer.js css/views/dashboard.css`
- `node -e "const m=require('./src/renderer/dashboardRenderer'); console.log(Object.keys(m).join(','))"`
