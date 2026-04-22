/**
 * Build script — obfuscates settlement.js → settlement.obf.js
 * Run: node obfuscate.js
 */
const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'settlement.js'), 'utf8');

const result = JavaScriptObfuscator.obfuscate(src, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: true,
  debugProtectionInterval: 4000,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 3,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 5,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
});

const outPath = path.join(__dirname, 'settlement.obf.js');
fs.writeFileSync(outPath, result.getObfuscatedCode());
console.log(`✅ Obfuscated → settlement.obf.js (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
