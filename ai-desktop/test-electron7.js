// Try to require the electron browser_init module
try {
  const browserInit = require("electron/js2c/browser_init");
  console.log("browser_init type:", typeof browserInit);
  console.log("browser_init keys:", Object.keys(browserInit).slice(0, 20));
  // Check if it has setup function
  if (browserInit.setup) console.log("has setup");
  if (browserInit.loadEmit) console.log("has loadEmit");
} catch(e) {
  console.log("browser_init ERROR:", e.message);
}

// Also try with node: prefix
try {
  const browserInit = require("node:electron/js2c/browser_init");
  console.log("node:electron/js2c/browser_init type:", typeof browserInit);
} catch(e) {
  console.log("node:electron/js2c/browser_init ERROR:", e.message);
}

// Try the isolation bundle  
try {
  const isolated = require("electron/js2c/isolated_bundle");
  console.log("isolated_bundle type:", typeof isolated);
  console.log("isolated_bundle keys:", Object.keys(isolated).slice(0, 20));
} catch(e) {
  console.log("isolated_bundle ERROR:", e.message);
}
