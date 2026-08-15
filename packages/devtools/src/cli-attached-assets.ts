import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { faviconLink, faviconSvg } from "./favicon.js";
import {
  attachedCliSecurityHeaders,
  isAttachedCliRecord,
  sendAttachedCliError,
} from "./cli-attached-http.js";

/**
 * The workbench shell. `apiBase` tells the interface where its JSON API is
 * mounted, and `launched` tells it the peer workbench is reachable from the
 * same origin, so the chrome can offer the switch.
 */
export function attachedCliShellPage(
  apiBase: string,
  launched: boolean,
): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invokta DevTools · CLI workbench</title>
${faviconLink}
<link rel="stylesheet" href="/assets/attached.css">
</head>
<body data-invokta-api="${apiBase}"${launched ? ' data-invokta-workbench="cli"' : ""}>
<noscript>The Invokta DevTools interface requires JavaScript.</noscript>
<script type="module" src="/assets/cli-app.js"></script>
</body>
</html>
`;
}

const staticContentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const assetSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultAttachedCliUiRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "ui");
}

export interface AttachedCliAssetServer {
  shell(response: ServerResponse, apiBase: string, launched: boolean): void;
  favicon(response: ServerResponse): void;
  serve(response: ServerResponse, segments: readonly string[]): Promise<void>;
}

export function createAttachedCliAssetServer(
  uiRoot: string,
): AttachedCliAssetServer {
  let attachedCss: Promise<string | undefined> | undefined;

  const notFound = (response: ServerResponse): void => {
    sendAttachedCliError(
      response,
      404,
      "NOT_FOUND",
      "The requested asset was not found.",
    );
  };

  const serveStyles = async (response: ServerResponse): Promise<void> => {
    attachedCss ??= import(
      pathToFileURL(join(uiRoot, "attached-styles.js")).href
    )
      .then((module: unknown) => {
        if (!isAttachedCliRecord(module)) return undefined;
        return typeof module.attachedStyles === "string"
          ? module.attachedStyles
          : undefined;
      })
      .catch(() => undefined);
    const css = await attachedCss;
    if (css === undefined) {
      notFound(response);
      return;
    }
    response.writeHead(200, {
      ...attachedCliSecurityHeaders(),
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(css);
  };

  const serveStatic = (
    response: ServerResponse,
    segments: readonly string[],
  ): void => {
    if (
      segments.length === 0 ||
      segments.some((segment) => !assetSegmentPattern.test(segment))
    ) {
      notFound(response);
      return;
    }
    const filePath = normalize(join(uiRoot, ...segments));
    if (
      !filePath.startsWith(`${normalize(uiRoot)}${sep}`) ||
      !existsSync(filePath)
    ) {
      notFound(response);
      return;
    }
    const extension = filePath.slice(filePath.lastIndexOf("."));
    const contentType = staticContentTypes[extension];
    if (contentType === undefined) {
      notFound(response);
      return;
    }
    response.writeHead(200, {
      ...attachedCliSecurityHeaders(),
      "content-type": contentType,
      "cache-control": "no-store",
    });
    response.end(readFileSync(filePath));
  };

  return {
    shell(response, apiBase, launched) {
      response.writeHead(200, {
        ...attachedCliSecurityHeaders(),
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(attachedCliShellPage(apiBase, launched));
    },
    favicon(response) {
      response.writeHead(200, {
        ...attachedCliSecurityHeaders(),
        "content-type": "image/svg+xml",
        "cache-control": "no-store",
      });
      response.end(faviconSvg);
    },
    async serve(response, segments) {
      if (segments.length === 1 && segments[0] === "attached.css") {
        await serveStyles(response);
        return;
      }
      serveStatic(response, segments);
    },
  };
}
