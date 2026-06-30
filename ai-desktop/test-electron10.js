const path = require('path');
const fs = require('fs');

// Try to create dist/lib/node directory for electron API
const distNodePath = path.join(
  process.resourcesPath.split(path.sep).slice(0, -1).join(path.sep),
  'lib', 'node'
);
console.log("Will create at:", distNodePath);

// Actually, use process.resourcesPath directly
const electronDist = path.dirname(process.resourcesPath);
console.log("electron dist:", electronDist);
const libNodePath = path.join(electronDist, 'lib', 'node');
console.log("lib/node path:", libNodePath);

fs.mkdirSync(libNodePath, { recursive: true });
console.log("Created directory");

// Now create electron.js
const electronJsPath = path.join(libNodePath, 'electron.js');
// We need to figure out what to export
// For now, just check what modules are available
const electronJSContent = `
// Check what internal modules exist
const builtinModules = require('module').builtinModules;
const electronBuiltins = builtinModules.filter(m => m.startsWith('electron/'));
console.log('[lib/node/electron.js] Electron builtins:', electronBuiltins);
module.exports = { version: process.versions.electron };
`;
fs.writeFileSync(electronJsPath, electronJSContent);
console.log("Created electron.js");

// Now remove node_modules/electron/index.js and try
const origIndex = path.join(electronDist, '..', 'index.js');
const bakIndex = origIndex + '.bak3';
fs.renameSync(origIndex, bakIndex);

// Clear require cache
Object.keys(require.cache).forEach(k => {
  if (k.includes('electron')) delete require.cache[k];
});

try {
  const e = require("electron");
  console.log("electron:", typeof e, JSON.stringify(e));
} catch(e) {
  console.log("electron ERROR:", e.message);
}

// Restore
fs.renameSync(bakIndex, origIndex);
fs.rmSync(libNodePath, { recursive: true });
