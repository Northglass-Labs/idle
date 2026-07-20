export function shouldAllowMermaidWebViewNavigation(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        return url.protocol === 'about:' && url.pathname === 'blank' && url.search === '';
    } catch {
        return false;
    }
}
