// Try to find the electron API through internal modules
const Module = require("module");
console.log("=== All node:electron modules ===");
// Try various potential internal module paths
const candidates = [
  "node:electron/js2c/node_init",
  "node:electron/js2c/asar_bundle",
];
for (const c of candidates) {
  try {
    const m = require(c);
    console.log(c, "->", typeof m, Object.keys(m).slice(0, 10));
  } catch(e) {
    console.log(c, "-> ERROR:", e.message.slice(0, 80));
  }
}
// Try the electronBinding approach
console.log("\n=== _linkedBinding attempts ===");
[
  "electron_common",
  "electron_browser",
  "electron_renderer",
  "electron",
  "app",
].forEach(name => {
  try {
    const b = process._linkedBinding(name);
    console.log(name, "->", typeof b, b ? Object.keys(b).slice(0, 5) : null);
  } catch(e) {
    console.log(name, "-> ERROR:", e.message.slice(0, 60));
  }
});
