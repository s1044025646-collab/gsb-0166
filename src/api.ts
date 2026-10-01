import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AppError } from "./errors.ts";
import { validateCell, validateScanParams } from "./validate.ts";
import { Store, deriveId } from "./db.ts";
import {
  ScanService,
  compareRevisions,
  exportPeakTable,
} from "./service.ts";
import { atomContributions, dSpacing, explainExtinction } from "./diffraction.ts";

const MAX_LIMIT = 200;

export interface ApiDeps {
  store: Store;
  service: ScanService;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new AppError("VALIDATION", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new AppError("VALIDATION", "body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function pagination(url: URL): { limit: number; offset: number } {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
    throw new AppError("VALIDATION", "limit/offset must be finite numbers");
  }
  return { limit, offset };
}

function pageEnvelope(
  url: URL,
  rows: unknown[],
  total: number,
  limit: number,
  offset: number,
) {
  const nextOffset = offset + rows.length;
  const params = new URLSearchParams(url.searchParams);
  params.set("limit", String(limit));
  return {
    data: rows,
    page: {
      total,
      limit,
      offset,
      returned: rows.length,
      hasMore: nextOffset < total,
      next: nextOffset < total ? `${url.pathname}?${withOffset(params, nextOffset)}` : null,
    },
  };
}

function withOffset(params: URLSearchParams, offset: number): string {
  params.set("offset", String(offset));
  return params.toString();
}

export function createApp(deps: ApiDeps): Server {
  const { store, service } = deps;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        return send(res, 200, { status: "ok" });
      }

      // ---- cells ----
      if (path === "/cells" && method === "GET") {
        const { limit, offset } = pagination(url);
        const { rows, total } = store.listCells(limit, offset);
        return send(res, 200, pageEnvelope(url, rows, total, limit, offset));
      }
      if (path === "/cells" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const cell = validateCell(body);
        const key = String(req.headers["idempotency-key"] ?? JSON.stringify(cell));
        const id = String(body.id ?? deriveId("cell", key));
        const before = store.getCell(id);
        const saved = store.upsertCell(cell, id);
        return send(res, before ? 200 : 201, { before: before ?? null, after: saved });
      }

      const cellMatch = /^\/cells\/([A-Za-z0-9_:-]+)$/.exec(path);
      if (cellMatch && method === "GET") {
        return send(res, 200, store.requireCell(cellMatch[1]!));
      }

      // ---- scans ----
      const scansMatch = /^\/cells\/([A-Za-z0-9_:-]+)\/scans$/.exec(path);
      if (scansMatch && method === "GET") {
        const cellId = scansMatch[1]!;
        store.requireCell(cellId);
        const { limit, offset } = pagination(url);
        const { rows, total } = store.listScans(cellId, limit, offset);
        return send(res, 200, pageEnvelope(url, rows, total, limit, offset));
      }
      if (scansMatch && method === "POST") {
        const cellId = scansMatch[1]!;
        const body = (await readBody(req)) as Record<string, unknown>;
        const params = validateScanParams(body);
        const idem = req.headers["idempotency-key"];
        const summary = service.createScan(
          cellId,
          params,
          typeof idem === "string" ? idem : undefined,
        );
        return send(res, 201, summary);
      }

      const scanMatch = /^\/scans\/([A-Za-z0-9_:-]+)$/.exec(path);
      if (scanMatch && method === "GET") {
        const scan = store.getScan(scanMatch[1]!);
        if (!scan) throw new AppError("NOT_FOUND", "scan not found");
        return send(res, 200, service.summarize(scan));
      }
      const reflMatch = /^\/scans\/([A-Za-z0-9_:-]+)\/reflections$/.exec(path);
      if (reflMatch && method === "GET") {
        const scan = store.getScan(reflMatch[1]!);
        if (!scan) throw new AppError("NOT_FOUND", "scan not found");
        const all = JSON.parse(scan.reflectionsJson) as unknown[];
        const { limit, offset } = pagination(url);
        const included = url.searchParams.get("included");
        const filtered =
          included === "true"
            ? all.filter((r) => (r as { included: boolean }).included)
            : included === "false"
              ? all.filter((r) => !(r as { included: boolean }).included)
              : all;
        const rows = filtered.slice(offset, offset + limit);
        return send(res, 200, pageEnvelope(url, rows, filtered.length, limit, offset));
      }
      const linesMatch = /^\/scans\/([A-Za-z0-9_:-]+)\/lines$/.exec(path);
      if (linesMatch && method === "GET") {
        const scan = store.getScan(linesMatch[1]!);
        if (!scan) throw new AppError("NOT_FOUND", "scan not found");
        const all = JSON.parse(scan.linesJson) as unknown[];
        const { limit, offset } = pagination(url);
        const rows = all.slice(offset, offset + limit);
        return send(res, 200, pageEnvelope(url, rows, all.length, limit, offset));
      }
      const csvMatch = /^\/scans\/([A-Za-z0-9_:-]+)\/export$/.exec(path);
      if (csvMatch && method === "GET") {
        const scan = store.getScan(csvMatch[1]!);
        if (!scan) throw new AppError("NOT_FOUND", "scan not found");
        const csv = exportPeakTable(JSON.parse(scan.linesJson));
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="peaks_${scan.id}.csv"`,
        });
        return res.end(csv);
      }

      // ---- live (non-persisted) diagnostics on a stored cell ----
      const contribMatch = /^\/cells\/([A-Za-z0-9_:-]+)\/contributions$/.exec(path);
      if (contribMatch && method === "GET") {
        const rec = store.requireCell(contribMatch[1]!);
        const cell = { a: rec.a, b: rec.b, c: rec.c, atoms: rec.atoms };
        const h = Number(url.searchParams.get("h"));
        const k = Number(url.searchParams.get("k"));
        const l = Number(url.searchParams.get("l"));
        if (![h, k, l].every(Number.isInteger)) {
          throw new AppError("VALIDATION", "h,k,l query params must be integers");
        }
        const result = atomContributions(cell, h, k, l);
        return send(res, 200, { h, k, l, dSpacing: dSpacing(cell, h, k, l), ...result });
      }
      const extinctMatch = /^\/cells\/([A-Za-z0-9_:-]+)\/extinction$/.exec(path);
      if (extinctMatch && method === "GET") {
        const rec = store.requireCell(extinctMatch[1]!);
        const cell = { a: rec.a, b: rec.b, c: rec.c, atoms: rec.atoms };
        const h = Number(url.searchParams.get("h"));
        const k = Number(url.searchParams.get("k"));
        const l = Number(url.searchParams.get("l"));
        if (![h, k, l].every(Number.isInteger)) {
          throw new AppError("VALIDATION", "h,k,l query params must be integers");
        }
        return send(res, 200, explainExtinction(cell, h, k, l));
      }

      // ---- occupancy revision comparison ----
      if (path === "/compare" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const baseCell = validateCell(body.base);
        const revisedCell = validateCell(body.revised);
        const params = validateScanParams(body.scan);
        return send(res, 200, { comparison: compareRevisions(baseCell, revisedCell, params) });
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `no route for ${method} ${path}` } });
    } catch (err) {
      if (err instanceof AppError) {
        const status =
          err.code === "NOT_FOUND"
            ? 404
            : err.code === "CONFLICT"
              ? 409
              : err.code === "UNPROCESSABLE"
                ? 422
                : 400;
        return send(res, status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      send(res, 500, {
        error: { code: "PERSISTENCE", message: (err as Error).message },
      });
    }
  });
}
