module.exports = {
  expo: {
    name: 'Idle Native Crypto Harness',
    slug: 'idle-native-crypto-harness',
    version: '0.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ios: {
      bundleIdentifier: 'com.northglass.idle.crypto-harness',
      supportsTablet: false,
    },
    plugins: ['@more-tech/react-native-libsodium'],
    updates: {
      enabled: false,
    },
  },
};
