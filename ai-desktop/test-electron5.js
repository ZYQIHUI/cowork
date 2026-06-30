// Check if electron API is available as a global
console.log("=== Checking globals ===");
const candidates = [
  "electron",
  "app",
  "BrowserWindow",
  "require",
];
for (const c of candidates) {
  console.log(`global.${c}:`, typeof global[c]);
  console.log(`globalThis.${c}:`, typeof globalThis[c]);
}

// Check if there's an electron object anywhere
console.log("\n=== Global keys with 'electron' ===");
Object.keys(globalThis).filter(k => k.toLowerCase().includes('electron')).forEach(k => {
  console.log(k, ":", typeof globalThis[k]);
});

// Check process.bindings  
console.log("\n=== process.bindings ===");
if (typeof process.bindings === 'function') {
  try {
    const names = process.bindings('electron');
    console.log("electron bindings:", names);
  } catch(e) {
    console.log("process.bindings error:", e.message);
  }
}

// Check Module.globalPaths
const Module = require("module");
console.log("\n=== Module.globalPaths ===");
console.log(Module.globalPaths);

// Check NODE_PATH
console.log("\n=== NODE_PATH ===");
console.log(process.env.NODE_PATH);
