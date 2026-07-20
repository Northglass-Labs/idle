const { withInfoPlist } = require('@expo/config-plugins');

/**
 * Idle does not use device-motion APIs. A transitive native dependency adds
 * NSMotionUsageDescription during prebuild, so strip the unused permission.
 *
 * This plugin must run LAST in app.config.js `plugins` so its Info.plist mod
 * applies after whichever dependency adds the key.
 */
module.exports = function withRemoveMotionPermission(config) {
    return withInfoPlist(config, (config) => {
        delete config.modResults.NSMotionUsageDescription;
        return config;
    });
};
