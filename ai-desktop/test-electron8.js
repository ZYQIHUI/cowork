// Deep search for electron API in process and global objects
console.log("=== All process properties ===");
Object.getOwnPropertyNames(process).sort().forEach(k => console.log("process." + k, ":", typeof process[k]));

console.log("\n=== Global properties (non-builtin) ===");
Object.getOwnPropertyNames(globalThis).filter(k => {
  return !["undefined", "null", "Boolean", "Number", "String", "Symbol", "Object", "Array", "Function", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "JSON", "Math", "NaN", "Infinity", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent", "escape", "unescape", "eval", "Intl", "Reflect", "Proxy", "Promise", "Map", "Set", "WeakMap", "WeakSet"].includes(k) && !k.startsWith('__')
}).forEach(k => console.log("global." + k, ":", typeof globalThis[k]));
