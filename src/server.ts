import { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Store } from "./db.ts";
import { ScanService } from "./service.ts";
import { createApp } from "./api.ts";

/**
 * Local-only server: binds 127.0.0.1 and requests an ephemeral port
 * (port 0) unless PXRD_PORT is given. Data and the pid/port record stay
 * inside the project directory.
 */
const dataDir = resolve(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.PXRD_DB ?? resolve(dataDir, "pxrd.sqlite");
const port = Number(process.env.PXRD_PORT ?? 0);

const store = Store.open(dbPath);
const service = new ScanService(store);
const server = createApp({ store, service });

server.listen(port, "127.0.0.1", () => {
  const addr = server.address() as AddressInfo;
  const info = { pid: process.pid, port: addr.port, host: "127.0.0.1", dbPath };
  writeFileSync(resolve(dataDir, "server.json"), JSON.stringify(info, null, 2));
  console.log(`pxrd API listening on http://127.0.0.1:${addr.port} (pid ${process.pid})`);
  console.log(`db: ${dbPath}`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, closing...`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
