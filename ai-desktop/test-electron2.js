const Module = require("module");
console.log("Original _load:", typeof Module._load);
console.log("_load.toString().slice(0, 100):", Module._load.toString().slice(0, 100));
// Check if _load has been overridden
const isNative = Module._load.toString().includes('[native code]');
console.log("Is native:", isNative);
// Check the require function
const e = require("electron");
console.log("electron:", typeof e, e ? e.toString().slice(0, 50) : null);
