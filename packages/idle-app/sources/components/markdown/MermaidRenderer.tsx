import * as React from 'react';
import { View, Platform, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { buildMermaidWebViewHtml } from './buildMermaidWebViewHtml';
import { shouldAllowMermaidWebViewNavigation } from './mermaidWebViewPolicy';

// Style for Web platform
const webStyle: any = {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 16,
    overflow: 'auto',
};

// Mermaid render component that works on all platforms
export const MermaidRenderer = React.memo((props: {
    content: string;
}) => {
    const { theme } = useUnistyles();
    const [dimensions, setDimensions] = React.useState({ width: 0, height: 200 });
    const [svgContent, setSvgContent] = React.useState<string | null>(null);

    const onLayout = React.useCallback((event: any) => {
        const { width } = event.nativeEvent.layout;
        setDimensions(prev => ({ ...prev, width }));
    }, []);

    // Web platform uses direct SVG rendering for better performance and native DOM integration
    if (Platform.OS === 'web') {
        const [hasError, setHasError] = React.useState(false);

        React.useEffect(() => {
            let isMounted = true;
            setHasError(false);

            const renderMermaid = async () => {
                try {
                    const mermaidModule: any = await import('mermaid');
                    const mermaid = mermaidModule.default || mermaidModule;

                    if (mermaid.initialize) {
                        mermaid.initialize({
                            startOnLoad: false,
                            theme: 'dark'
                        });
                    }

                    if (mermaid.render) {
                        const { svg } = await mermaid.render(
                            `mermaid-${Date.now()}`,
                            props.content
                        );

                        if (isMounted) {
                            setSvgContent(svg);
                        }
                    }
                } catch (error) {
                    if (isMounted) {
                        console.warn('Mermaid render failed');
                        setHasError(true);
                    }
                }
            };

            renderMermaid();

            return () => {
                isMounted = false;
            };
        }, [props.content]);

        if (hasError) {
            return (
                <View style={[style.container, style.errorContainer]}>
                    <View style={style.errorContent}>
                        <Text style={style.errorText}>Mermaid diagram syntax error</Text>
                        <View style={style.codeBlock}>
                            <Text style={style.codeText}>{props.content}</Text>
                        </View>
                    </View>
                </View>
            );
        }

        if (!svgContent) {
            return (
                <View style={[style.container, style.loadingContainer]}>
                    <View style={style.loadingPlaceholder} />
                </View>
            );
        }

        return (
            <View style={style.container}>
                {/* @ts-ignore - Web only */}
                <div
                    style={webStyle}
                    dangerouslySetInnerHTML={{ __html: svgContent }}
                />
            </View>
        );
    }

    // Native rendering uses a WebView. The pure HTML builder JSON-encodes and
    // escapes untrusted session content and forces Mermaid's strict security
    // level before it crosses the document boundary.
    const html = buildMermaidWebViewHtml({
        content: props.content,
        backgroundColor: theme.colors.surfaceHighest,
    });

    return (
        <View style={style.container} onLayout={onLayout}>
            <View style={[style.innerContainer, { height: dimensions.height }]}>
                <WebView
                    source={{ html }}
                    style={{ flex: 1 }}
                    scrollEnabled={false}
                    originWhitelist={['about:blank']}
                    onShouldStartLoadWithRequest={(request) => shouldAllowMermaidWebViewNavigation(request.url)}
                    javaScriptCanOpenWindowsAutomatically={false}
                    setSupportMultipleWindows={false}
                    allowFileAccess={false}
                    allowFileAccessFromFileURLs={false}
                    allowUniversalAccessFromFileURLs={false}
                    mixedContentMode="never"
                    sharedCookiesEnabled={false}
                    thirdPartyCookiesEnabled={false}
                    cacheEnabled={false}
                    incognito={true}
                    onMessage={(event) => {
                        try {
                            const data = JSON.parse(event.nativeEvent.data);
                            if (data.type === 'dimensions' && typeof data.height === 'number') {
                                setDimensions(prev => ({
                                    ...prev,
                                    height: Math.max(prev.height, data.height)
                                }));
                            }
                        } catch {
                            // Malformed postMessage from WebView (e.g., partial JSON) — ignore.
                            // Better to drop a dimension update than crash the chat render.
                        }
                    }}
                />
            </View>
        </View>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
    innerContainer: {
        width: '100%',
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
    },
    loadingContainer: {
        justifyContent: 'center',
        alignItems: 'center',
        height: 100,
    },
    loadingPlaceholder: {
        width: 200,
        height: 20,
        backgroundColor: theme.colors.divider,
        borderRadius: 4,
    },
    errorContainer: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        padding: 16,
    },
    errorContent: {
        flexDirection: 'column',
        gap: 12,
    },
    errorText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 4,
        padding: 12,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
}));
