// Try process.getBuiltinModule
console.log("=== getBuiltinModule ===");
try {
  const m = process.getBuiltinModule("electron/js2c/browser_init");
  console.log("browser_init:", typeof m, m ? Object.keys(m).slice(0, 10) : null);
} catch(e) {
  console.log("browser_init ERROR:", e.message);
}

// Try node_init
try {
  const m = process.getBuiltinModule("electron/js2c/node_init");
  console.log("node_init:", typeof m, m ? Object.keys(m).slice(0, 10) : null);
} catch(e) {
  console.log("node_init ERROR:", e.message);
}

// Try the source module (original Node.js behavior)
const Module = require("module");
console.log("\n=== Trying require with different base paths ===");
// Try requiring from electron's dist/lib/node path
const distLibNode = "c:\Users\Administrator\Desktop\大三下\智能制造\课程大作业-Agent高级开发-AI桌面端\ai-desktop\node_modules\electron\dist\lib\node";
console.log("dist/lib/node exists:", require('fs').existsSync(distLibNode));

// Create the directory and an electron.js that requires internal modules
require('fs').mkdirSync(distLibNode, { recursive: true });
const electronJs = distLibNode + "\electron.js";
require('fs').writeFileSync(electronJs, `
// Attempt to get electron API from internal source
try {
  const browserInit = process.getBuiltinModule("electron/js2c/browser_init");
  if (browserInit) module.exports = browserInit;
} catch(e) {
  console.log("Failed to get browser_init:", e.message);
}
`);
console.log("Created:", electronJs);

// Now remove node_modules/electron/index.js temporarily and try
const origIndexPath = "c:\Users\Administrator\Desktop\大三下\智能制造\课程大作业-Agent高级开发-AI桌面端\ai-desktop\node_modules\electron\index.js";
const bakPath = origIndexPath + ".bak2";
require('fs').renameSync(origIndexPath, bakPath);

// Clear require cache
delete require.cache[require.resolve("electron")];

try {
  const e = require("electron");
  console.log("electron after fix:", typeof e, e ? Object.keys(e).slice(0, 10) : null);
} catch(e) {
  console.log("electron ERROR:", e.message);
}

// Restore
require('fs').renameSync(bakPath, origIndexPath);
require('fs').rmSync(distLibNode, { recursive: true });
