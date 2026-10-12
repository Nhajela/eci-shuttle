// Expo's default config detects the pnpm workspace (watchFolders + nodeModulesPaths), so nothing to add yet.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
