const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const harnessRoot = __dirname;
const idleAppRoot = path.resolve(harnessRoot, '../..');
const repositoryRoot = path.resolve(idleAppRoot, '../..');
const config = getDefaultConfig(harnessRoot);
const reactEntry = require.resolve('react', { paths: [idleAppRoot] });
const reactJsxRuntimeEntry = require.resolve('react/jsx-runtime', { paths: [idleAppRoot] });
const reactJsxDevRuntimeEntry = require.resolve('react/jsx-dev-runtime', { paths: [idleAppRoot] });

// The harness imports the shipping adapters from the parent app package. It is
// otherwise a standalone Expo project and never enters the app's route graph.
config.watchFolders = [idleAppRoot];
config.resolver.nodeModulesPaths = [
  path.join(idleAppRoot, 'node_modules'),
  path.join(repositoryRoot, 'node_modules'),
];

// Yarn's no-hoist layout leaves another React copy beneath Expo. A second
// dispatcher makes hooks fail at runtime, so pin every React entry to the same
// copy used by the app's React Native package.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'react') {
    return { filePath: reactEntry, type: 'sourceFile' };
  }
  if (moduleName === 'react/jsx-runtime') {
    return { filePath: reactJsxRuntimeEntry, type: 'sourceFile' };
  }
  if (moduleName === 'react/jsx-dev-runtime') {
    return { filePath: reactJsxDevRuntimeEntry, type: 'sourceFile' };
  }
  if (moduleName === 'react-native' || moduleName.startsWith('react-native/')) {
    return {
      filePath: require.resolve(moduleName, { paths: [idleAppRoot] }),
      type: 'sourceFile',
    };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
