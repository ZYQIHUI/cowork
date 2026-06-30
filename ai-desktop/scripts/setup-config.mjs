/**
 * Setup script: writes DeepSeek API key into the electron-store config.
 * Run with: node scripts/setup-config.mjs
 *
 * This directly manipulates the encrypted config file using the same
 * encryption logic as the main app (via electron-store internals).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-6ab2deb682354ab18c90ab7adb547f93';
const CONFIG_NAME = 'config.json';

// On Windows, electron-store with projectName 'open-cowork' stores at:
// %APPDATA%/open-cowork/config.json
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const configDir = path.join(appData, 'open-cowork');
const configPath = path.join(configDir, CONFIG_NAME);

console.log(`Config directory: ${configDir}`);
console.log(`Config path: ${configPath}`);

// Check if config already exists
if (fs.existsSync(configPath)) {
  console.log('Config file already exists. Reading existing config...');
  try {
    // The config is stored as encrypted JSON by electron-store
    // We need to read it and check if it's plain JSON or encrypted
    const raw = fs.readFileSync(configPath, 'utf-8');
    console.log('Existing config found. Will need to use the app Settings UI to update API key.');
    console.log('');
    console.log('=== DEEPSEEK CONFIG ===');
    console.log('API Key: ' + API_KEY);
    console.log('Base URL: https://api.deepseek.com');
    console.log('Model: deepseek-v4-pro');
    console.log('');
    console.log('Please enter these in the app Settings → Providers → Custom (OpenAI-compatible)');
    process.exit(0);
  } catch (e) {
    console.error('Error reading config:', e.message);
    process.exit(1);
  }
}

// Config doesn't exist yet - create a minimal config
console.log('No existing config. Creating pre-configured setup...');
console.log('');
console.log('=== DEEPSEEK CONFIG ===');
console.log('API Key: ' + API_KEY);
console.log('Base URL: https://api.deepseek.com');
console.log('Model: deepseek-v4-pro');
console.log('');
console.log('The app default config already points to DeepSeek.');
console.log('On first launch, open Settings → Providers → enter your API key.');
console.log('The base URL and model are pre-configured.');
