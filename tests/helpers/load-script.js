const path = require("node:path");

function resetHelper() {
  delete globalThis.__CHATGPT_HELPER__;
}

function loadScript(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  delete require.cache[require.resolve(absolutePath)];
  require(absolutePath);
  return globalThis.__CHATGPT_HELPER__;
}

module.exports = { loadScript, resetHelper };
