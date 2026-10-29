# My App — Electron

A minimal Electron app. Main process in `src/main.js`, UI in `src/index.html`, and everything the page needs from the system goes through `src/preload.js` (contextIsolation stays on).

## Commands

- Set up: `npm install`
- Run: `npm start`
- Test: `npm test`
- Build installers: `npm run dist` → `dist/` (NSIS installer + portable .exe)
- Release: bump `version` in package.json, tag `vX.Y.Z` (must match!), publish a GitHub release — the workflow checks the tag against package.json, builds, and attaches the installers.

## Rules

- Never turn off contextIsolation or enable nodeIntegration; add preload functions instead.
- Add a test in `test/` for every module with logic; keep `npm test` green before a commit.
