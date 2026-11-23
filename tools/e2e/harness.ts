import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import worker from "../../apps/worker/src/index.js";
import type { WorkerEnvironment } from "../../apps/worker/src/layers/l4-application-integration/api.js";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

export interface UnifiedServer {
  /** Loopback origin, e.g. http://127.0.0.1:53124. */
  readonly baseUrl: string;
  close(): void;
}

/**
 * One loopback server for the browser tools: `/api/v1/*` goes to the Worker's fetch handler, everything else is
 * served from the built web app (`distDir`) with an SPA fallback to index.html. The origin is written into
 * `env.AUTH_APP_ORIGIN` once the port is known. Shared by the browser journey and the accessibility audit.
 */
export async function startUnifiedServer(options: {
  readonly distDir: string;
  readonly env: WorkerEnvironment;
}): Promise<UnifiedServer> {
  const { distDir, env } = options;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname.startsWith("/api/v1")) {
        // Collect request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const bodyBuf = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v !== undefined) {
            if (Array.isArray(v)) {
              v.forEach((val) => headers.append(k, val));
            } else {
              headers.set(k, v);
            }
          }
        }

        const webReq = new Request(url.href, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : bodyBuf,
        });

        const webRes = await worker.fetch(webReq, env);
        res.statusCode = webRes.status;
        webRes.headers.forEach((v, k) => {
          res.setHeader(k, v);
        });
        const resBuf = Buffer.from(await webRes.arrayBuffer());
        res.end(resBuf);
      } else {
        // Serve static web files or SPA fallback
        let targetFile = path.join(distDir, url.pathname);
        if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
          targetFile = path.join(distDir, "index.html");
        }
        const ext = path.extname(targetFile);
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        const content = fs.readFileSync(targetFile);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      }
    } catch (err) {
      console.error("Server error handling request:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  env.AUTH_APP_ORIGIN = baseUrl;

  return {
    baseUrl,
    close: () => {
      server.close();
    },
  };
}
