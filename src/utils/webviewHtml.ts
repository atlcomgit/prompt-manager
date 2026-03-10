/**
 * Utility: get webview HTML boilerplate
 */
import * as vscode from 'vscode';
import { getNonce } from './nonce.js';

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  scriptPath: string,
  title: string,
  locale?: string
): string {
  const lang = locale || vscode.env.language || 'en';
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, scriptPath)
  );

  const codiconsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
  );

  const nonce = getNonce();

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    font-src ${webview.cspSource};
    script-src 'nonce-${nonce}';
    img-src ${webview.cspSource} https: data:;
  ">
  <title>${title}</title>
  <link rel="stylesheet" href="${codiconsUri}">
  <style>
    :root {
      --pm-spacing-xs: 4px;
      --pm-spacing-sm: 8px;
      --pm-spacing-md: 12px;
      --pm-spacing-lg: 16px;
      --pm-spacing-xl: 24px;
      --pm-border-radius: 4px;
      --pm-transition: 0.15s ease;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      overflow: hidden;
    }

    #root {
      width: 100%;
      height: 100vh;
      overflow: hidden;
    }

    /* Scrollbar styling */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }

    /* Focus styles */
    button {
      -webkit-appearance: none;
      appearance: none;
      background-image: none;
      box-shadow: none;
      outline: none;
    }

    button::-moz-focus-inner {
      border: 0;
      padding: 0;
    }

    :where(input, textarea, select, [contenteditable="true"]):focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    button:focus,
    button:focus-visible,
    button:active {
      outline: none;
      box-shadow: none;
    }

    button:disabled,
    button[aria-disabled="true"] {
      border: none !important;
      outline: none !important;
      box-shadow: none !important;
      -webkit-appearance: none;
      appearance: none;
    }

    /* Loading spinner animation */
    @keyframes pm-spin {
      to { transform: rotate(360deg); }
    }

    /* Fade-in for loading overlay */
    @keyframes pm-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__LOCALE__='${lang}';</script>
  <script nonce="${nonce}">
    (() => {
      let pointerPressedButton = null;

      const blurIfInactiveButtonFocused = () => {
        const activeElement = document.activeElement;
        if (!(activeElement instanceof HTMLButtonElement)) {
          return;
        }

        if (activeElement.disabled || activeElement.getAttribute('aria-disabled') === 'true') {
          activeElement.blur();
        }
      };

      document.addEventListener('pointerdown', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          pointerPressedButton = null;
          return;
        }

        pointerPressedButton = target.closest('button');
      }, true);

      document.addEventListener('click', () => {
        if (!(pointerPressedButton instanceof HTMLElement)) {
          pointerPressedButton = null;
          return;
        }

        const buttonToBlur = pointerPressedButton;
        pointerPressedButton = null;

        window.requestAnimationFrame(() => {
          buttonToBlur.blur();
          if (document.activeElement instanceof HTMLElement && document.activeElement.tagName === 'BUTTON') {
            document.activeElement.blur();
          }

          blurIfInactiveButtonFocused();
        });
      }, true);

      const observer = new MutationObserver(() => {
        blurIfInactiveButtonFocused();
      });

      observer.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'class', 'style'],
      });
    })();
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
