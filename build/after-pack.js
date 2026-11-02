'use strict';
// macOS 15 (Sequoia) silently denies local-network access — no prompt, no Settings entry —
// to any bundle whose Info.plist lacks NSLocalNetworkUsageDescription. electron-builder's
// extendInfo covers the main app plist, but Electron's helper apps make network calls of
// their own, so the key goes into every Helper bundle too (a field report's Mac could not
// reach its Tailscale node at all: fetch failed with EACCES and the app never appeared under
// System Settings → Privacy & Security → Local Network).
const fs = require('fs');
const path = require('path');

const KEY = 'NSLocalNetworkUsageDescription';
const TEXT = 'Qwen Workspace connects to Ollama servers on your other computers (the nodes you add in Settings) and serves remote sessions to your paired devices.';

function patchPlist(file) {
  let plist = fs.readFileSync(file, 'utf8');
  if (plist.includes(KEY)) return false;
  const tail = plist.lastIndexOf('</dict>');
  if (tail < 0) return false;
  plist = `${plist.slice(0, tail)}\t<key>${KEY}</key>\n\t<string>${TEXT}</string>\n${plist.slice(tail)}`;
  fs.writeFileSync(file, plist);
  return true;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appDir = fs.readdirSync(context.appOutDir).find((n) => n.endsWith('.app'));
  if (!appDir) return;
  const frameworks = path.join(context.appOutDir, appDir, 'Contents', 'Frameworks');
  if (!fs.existsSync(frameworks)) return;
  for (const name of fs.readdirSync(frameworks)) {
    if (!name.endsWith('.app')) continue; // the Electron Helper bundles
    const plist = path.join(frameworks, name, 'Contents', 'Info.plist');
    if (fs.existsSync(plist) && patchPlist(plist)) console.log(`afterPack: added ${KEY} to ${name}`);
  }
};
