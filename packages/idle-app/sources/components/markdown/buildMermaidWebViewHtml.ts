/**
 * Pure builder for the WebView HTML hosting a Mermaid diagram render on iOS / Android.
 *
 * Session-controlled diagram source stays inside a JSON-encoded JavaScript string and never
 * enters the host document as HTML. Escaping literal `<` characters enforces the JSON-in-HTML
 * boundary so content cannot terminate the host script. Mermaid receives the decoded source
 * and renders strict-mode SVG into an initially empty container.
 *
 * The background color is sanitized to color-only characters (so a malicious theme injection
 * via CSS can't break out of the `body { background-color: ... }` rule).
 *
 * The pure builder has no React Native dependency and is covered in plain Vitest.
 */

const SAFE_COLOR_REGEX = /[^#0-9a-zA-Z(),.\s%]/g;

export function buildMermaidWebViewHtml(args: {
    content: string;
    backgroundColor: string;
}): string {
    // JSON.stringify wraps the string in quotes and escapes \, ", \n, \r, etc.
    // Replace < with \u003c to prevent the HTML parser from interpreting a literal "</script>"
    // inside content as the end of our injected <script> tag — standard JSON-in-HTML safety.
    const safeContent = JSON.stringify(args.content).replace(/</g, '\\u003c');

    // Strip anything that isn't a valid CSS color character. Allows hex (#abc), rgb()/rgba()
    // function syntax, named colors, hsl/hsla, percentages, spaces.
    const safeBg = args.backgroundColor.replace(SAFE_COLOR_REGEX, '') || '#000000';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'">
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js" integrity="sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E" crossorigin="anonymous"></script>
    <style>
        body {
            margin: 0;
            padding: 16px;
            background-color: ${safeBg};
        }
        #mermaid-container {
            display: flex;
            justify-content: center;
            align-items: center;
            width: 100%;
        }
        #mermaid-container svg {
            max-width: 100%;
            height: auto;
        }
    </style>
</head>
<body>
    <div id="mermaid-container"></div>
    <script>
        (async function() {
            try {
                if (typeof mermaid === 'undefined') {
                    document.getElementById('mermaid-container').textContent = 'Mermaid library failed to load';
                    return;
                }
                mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
                var source = ${safeContent};
                var rendered = await mermaid.render('m', source);
                document.getElementById('mermaid-container').innerHTML = rendered.svg;
            } catch (e) {
                var msg = (e && e.message) ? e.message : String(e);
                var pre = document.createElement('pre');
                pre.style.color = '#fff';
                pre.style.fontFamily = 'monospace';
                pre.textContent = 'Mermaid render error: ' + msg;
                document.getElementById('mermaid-container').appendChild(pre);
            }
        })();
    </script>
</body>
</html>`;
}
