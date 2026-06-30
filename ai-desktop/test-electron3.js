const Module = require("module");
// Print the full _load function to see if it handles "electron"
const loadStr = Module._load.toString();
console.log("=== _load function ===");
console.log(loadStr);
console.log("=== end ===");
// Also check _resolveFilename
const resolveStr = Module._resolveFilename.toString();
console.log("=== _resolveFilename (first 500 chars) ===");
console.log(resolveStr.slice(0, 500));
