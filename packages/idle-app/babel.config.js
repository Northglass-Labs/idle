module.exports = function (api) {
  api.cache(true);

  // Determine which worklets plugin to use based on installed versions
  // Reanimated v4+ uses react-native-worklets/plugin
  // Reanimated v3.x uses react-native-reanimated/plugin
  let workletsPlugin = 'react-native-worklets/plugin';
  try {
    const reanimatedVersion = require('react-native-reanimated/package.json').version;
    const majorVersion = parseInt(reanimatedVersion.split('.')[0], 10);

    // For Reanimated v3.x, use the old plugin
    if (majorVersion < 4) {
      workletsPlugin = 'react-native-reanimated/plugin';
    }
  } catch (e) {
    // If reanimated isn't installed, default to newer plugin
    // This won't cause issues since the plugin won't be needed anyway
  }

  // Strip arbitrary console payloads from production builds while retaining
  // development diagnostics. Error and warning signals remain available to
  // the release error boundary without shipping routine payload logs.
  // `error` is preserved so genuine errors still surface in crash reports.
  const removeConsolePlugin = ['transform-remove-console', { exclude: ['error', 'warn'] }];

  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ['react-native-unistyles/plugin', { root: 'sources' }],
      ...(process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production'
        ? [removeConsolePlugin]
        : []),
      workletsPlugin // Must be last - automatically selects correct plugin for version
    ],
  };
};
