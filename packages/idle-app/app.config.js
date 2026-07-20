const { execFileSync } = require('node:child_process');
const appPackage = require('./package.json');

const variant = process.env.APP_ENV || 'development';
const googleServicesFile = process.env.IDLE_GOOGLE_SERVICES_FILE?.trim();
const name = {
    development: "Idle (dev)",
    preview: "Idle (preview)",
    production: "Idle"
}[variant];
const bundleId = {
    development: "com.northglass.idle.dev",
    preview: "com.northglass.idle.preview",
    production: "com.northglass.idle"
}[variant];
function git(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

function collectedDataType(type, purposes) {
    return {
        NSPrivacyCollectedDataType: type,
        NSPrivacyCollectedDataTypeLinked: true,
        NSPrivacyCollectedDataTypeTracking: false,
        NSPrivacyCollectedDataTypePurposes: purposes,
    };
}

function loadBuildMetadata() {
    const commitSha =
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.GITHUB_SHA ||
        git(['rev-parse', 'HEAD']);
    const commitTimestamp =
        (commitSha
            ? git(['show', '-s', '--format=%cI', commitSha])
            : git(['show', '-s', '--format=%cI', 'HEAD']));

    return {
        commitSha,
        commitTimestamp,
    };
}

const buildMetadata = loadBuildMetadata();

export default {
    expo: {
        name,
        slug: "idle",
        version: appPackage.version,
        runtimeVersion: "22",
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme: "idle",
        userInterfaceStyle: "automatic",
        notification: {
            icon: "./sources/assets/images/icon-notification.png",
            iosDisplayInForeground: true
        },
        ios: {
            // iOS 18 supports Light / Dark / Tinted icon variants. Light and Dark share the
            // branded asset because it is designed for both presentations.
            // Tinted is a grayscale-on-transparent silhouette per Apple HIG; iOS picks the tint.
            icon: {
                light:  "./sources/assets/images/icon.png",
                dark:   "./sources/assets/images/icon-dark.png",
                tinted: "./sources/assets/images/icon-tinted.png",
            },
            supportsTablet: true,
            bundleIdentifier: bundleId,
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.",
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"],
                // The hosted API is pinned to the current Let's Encrypt root
                // SPKIs. Custom self-hosted domains use the normal iOS trust policy.
                NSAppTransportSecurity: {
                    // Remote and LAN relays require HTTPS in production. Local-network
                    // permission supports discovery and trusted local HTTPS endpoints;
                    // it is not an exception for cleartext relay URLs. Dev/preview builds
                    // may use arbitrary HTTP for local testing. Per-domain pinning below
                    // still applies to the hosted API.
                    NSAllowsLocalNetworking: true,
                    ...(variant === 'production' ? {} : { NSAllowsArbitraryLoads: true }),
                    NSPinnedDomains: {
                        "idle-api.northglass.io": {
                            NSIncludesSubdomains: false,
                            NSPinnedCAIdentities: [
                                // ISRG Root X1 (RSA, primary LE root)
                                { "SPKI-SHA256-BASE64": "C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=" },
                                // ISRG Root X2 (ECDSA, secondary LE root for forward compat)
                                { "SPKI-SHA256-BASE64": "diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=" }
                            ]
                        }
                    }
                }
            },
            associatedDomains: variant === 'production' ? ["applinks:idle.northglass.io"] : [],
            // Apple Privacy Manifest. Keep this aligned with the shipped app,
            // third-party processors, public privacy notice, and App Store
            // Connect answers. Optional collection still requires disclosure.
            // Idle does not perform cross-app tracking.
            //
            // NSPrivacyAccessedAPITypes covers the required-reasons APIs used by
            // the shipped app and its bundled runtime SDKs:
            //     * UserDefaults (CA92.1 — "Access info from same app") — for our own settings
            //     * FileTimestamp (C617.1 — "Inside app container, app group container, or
            //       app's CloudKit container") — used by attachment temp files and caches
            //     * SystemBootTime (35F9.1 — "Measure the amount of time that has elapsed
            //       between events that occurred within the app or to perform calculations to
            //       enable timers") — used by connection, voice, and runtime timers
            //     * DiskSpace (E174.1 — "Display disk space info to the user") — used by
            //       the bundled runtime's storage and update diagnostics
            // OtherDiagnosticData is limited to consent-gated event/error codes and
            // bounded device/build context. It excludes provider credentials, prompts,
            // account/session identifiers, URLs, and raw error payloads.
            privacyManifests: {
                NSPrivacyTracking: false,
                NSPrivacyTrackingDomains: [],
                NSPrivacyCollectedDataTypes: [
                    collectedDataType(
                        "NSPrivacyCollectedDataTypeAudioData",
                        ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
                    ),
                    collectedDataType(
                        "NSPrivacyCollectedDataTypeDeviceID",
                        [
                            "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                            "NSPrivacyCollectedDataTypePurposeAnalytics",
                            "NSPrivacyCollectedDataTypePurposeProductPersonalization"
                        ]
                    ),
                    collectedDataType(
                        "NSPrivacyCollectedDataTypeOtherDiagnosticData",
                        [
                            "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                            "NSPrivacyCollectedDataTypePurposeAnalytics"
                        ]
                    ),
                    collectedDataType(
                        "NSPrivacyCollectedDataTypeOtherUserContent",
                        ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
                    ),
                    collectedDataType(
                        "NSPrivacyCollectedDataTypePhotosorVideos",
                        ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
                    ),
                    collectedDataType(
                        "NSPrivacyCollectedDataTypeProductInteraction",
                        ["NSPrivacyCollectedDataTypePurposeAnalytics"]
                    ),
                    collectedDataType(
                        "NSPrivacyCollectedDataTypePurchaseHistory",
                        [
                            "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                            "NSPrivacyCollectedDataTypePurposeAnalytics"
                        ]
                    ),
                    collectedDataType(
                        "NSPrivacyCollectedDataTypeUserID",
                        [
                            "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                            "NSPrivacyCollectedDataTypePurposeAnalytics"
                        ]
                    )
                ],
                NSPrivacyAccessedAPITypes: [
                    {
                        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
                        NSPrivacyAccessedAPITypeReasons: ["CA92.1"]
                    },
                    {
                        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
                        NSPrivacyAccessedAPITypeReasons: ["C617.1"]
                    },
                    {
                        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
                        NSPrivacyAccessedAPITypeReasons: ["35F9.1"]
                    },
                    {
                        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
                        NSPrivacyAccessedAPITypeReasons: ["E174.1"]
                    }
                ]
            }
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                monochromeImage: "./sources/assets/images/icon-monochrome.png",
                backgroundColor: "#0A0A0A"
            },
            permissions: [
                "android.permission.RECORD_AUDIO",
                "android.permission.MODIFY_AUDIO_SETTINGS",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.POST_NOTIFICATIONS",
            ],
            blockedPermissions: [
                "android.permission.ACTIVITY_RECOGNITION",
                // The app does not use external storage or broad media access.
                "android.permission.READ_EXTERNAL_STORAGE",
                "android.permission.WRITE_EXTERNAL_STORAGE",
                "android.permission.READ_MEDIA_IMAGES",
                "android.permission.READ_MEDIA_VIDEO",
            ],
            package: bundleId,
            ...(googleServicesFile ? { googleServicesFile } : {}),
            intentFilters: variant === 'production' ? [
                {
                    "action": "VIEW",
                    "autoVerify": true,
                    "data": [
                        {
                            "scheme": "https",
                            "host": "idle.northglass.io",
                            "pathPrefix": "/"
                        }
                    ],
                    "category": ["BROWSABLE", "DEFAULT"]
                }
            ] : []
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            require("./plugins/withEinkCompatibility.js"),
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-updates",
            "expo-asset",
            "expo-localization",
            "expo-mail-composer",
            "expo-secure-store",
            "expo-web-browser",
            "react-native-vision-camera",
            "@more-tech/react-native-libsodium",
            "react-native-audio-api",
            "@livekit/react-native-expo-plugin",
            "@config-plugins/react-native-webrtc",
            [
                "expo-audio",
                {
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations."
                }
            ],
            [
                "expo-camera",
                {
                    cameraPermission: "Allow $(PRODUCT_NAME) to access your camera to scan QR codes and share photos with AI.",
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations.",
                    recordAudioAndroid: true
                }
            ],
            [
                "expo-notifications",
                {
                    "enableBackgroundRemoteNotifications": true,
                    "icon": "./sources/assets/images/icon-notification.png"
                }
            ],
            [
                'expo-splash-screen',
                {
                    ios: {
                        backgroundColor: "#FAFAFA",
                        dark: {
                            backgroundColor: "#0A0A0A",
                        }
                    },
                    android: {
                        image: "./sources/assets/images/splash-android-light.png",
                        backgroundColor: "#E8EDF2",
                        dark: {
                            image: "./sources/assets/images/splash-android-dark.png",
                            backgroundColor: "#0A0F1A",
                        }
                    }
                }
            ],
            // Strips NSMotionUsageDescription — Idle does not use device motion.
            // Must stay last so it runs after the dep that injects the key.
            require("./plugins/withRemoveMotionPermission.js"),
        ],
        updates: {
            url: "https://u.expo.dev/4bf135bf-9225-4e91-9603-9d975bb499c8",
            codeSigningCertificate: "./certs/certificate.pem",
            codeSigningMetadata: {
                keyid: "main",
                alg: "rsa-v1_5-sha256"
            },
            requestHeaders: {
                "expo-channel-name": variant
            }
        },
        experiments: {
            typedRoutes: true
        },
        extra: {
            router: {
                root: "./sources/app"
            },
            eas: {
                projectId: "4bf135bf-9225-4e91-9603-9d975bb499c8"
            },
            app: {
                postHogKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
                revenueCatAppleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE,
                revenueCatGoogleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE,
                revenueCatStripeKey: process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE,
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
            }
        },
        owner: "northglass"
    }
};
