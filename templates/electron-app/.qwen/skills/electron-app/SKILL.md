---
name: electron-app
description: How to develop, test and ship this Electron app.
---

# Working on this Electron app

- Three layers: `src/main.js` (windows, files, OS), `src/preload.js` (the safe bridge), `src/index.html` (the page). The page never gets Node access — expose one function per capability in the preload with contextBridge.
- Use `ipcMain.handle` / `ipcRenderer.invoke` pairs; validate every argument in the main process.
- `npm test` uses node --test; keep logic in plain modules so it can be tested without launching Electron.
- Ship: the version in package.json must equal the release tag (the workflow fails otherwise). `npm run dist` builds the NSIS installer and the portable .exe.
