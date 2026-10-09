/**
 * Static server for the example game.
 *
 * No bundler: `/vendor/three/*` is served straight from node_modules and
 * `/vendor/gameprob/*` from the built package, so the example exercises exactly
 * the artifact that ships. Relative imports inside those files (for example
 * `three.module.js` → `three.core.js`) keep working because the whole directory
 * is reachable.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..", "..");

const PAGES = {
  "/": { path: join(here, "index.html"), type: "text/html; charset=utf-8" },
  "/index.html": { path: join(here, "index.html"), type: "text/html; charset=utf-8" },
  "/main.js": { path: join(here, "main.js"), type: "text/javascript; charset=utf-8" },
  "/favicon.ico": { path: join(here, "index.html"), type: "text/html; charset=utf-8" },
};

const VENDOR = [
  { prefix: "/vendor/three/", base: join(repoRoot, "node_modules", "three", "build") },
  { prefix: "/vendor/gameprob/", base: join(repoRoot, "dist") },
];

function resolveRoute(pathname) {
  const page = PAGES[pathname];
  if (page) return page;
  for (const vendor of VENDOR) {
    if (!pathname.startsWith(vendor.prefix)) continue;
    const relativeName = pathname.slice(vendor.prefix.length);
    if (relativeName.length === 0 || relativeName.includes("..")) return null;
    const path = join(vendor.base, relativeName);
    if (!path.startsWith(vendor.base)) return null;
    const type = relativeName.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "application/octet-stream";
    return { path, type };
  }
  return null;
}

export function createExampleServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = resolveRoute(url.pathname);
    if (!route || !existsSync(route.path) || !statSync(route.path).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        `Not found: ${url.pathname}\n` +
          (url.pathname.startsWith("/vendor/")
            ? "Run `pnpm install && pnpm build` before starting the example server.\n"
            : ""),
      );
      return;
    }
    response.writeHead(200, { "content-type": route.type, "cache-control": "no-store" });
    createReadStream(route.path).pipe(response);
  });
}

export async function startExampleServer(port = 0) {
  const server = createExampleServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/`,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise(undefined))),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 5199);
  const started = await startExampleServer(port);
  console.log(`Example game listening on ${started.url}?gameprob=1`);
  const shutdown = async () => {
    await started.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
