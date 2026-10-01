import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './db.ts';
import { explainExtinction, ValidationError } from './physics.ts';
import type { Atom, CellParams } from './physics.ts';

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

// Parse limit/offset cursor. Defaults are small and explicit.
function pageParams(url: URL) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));
  if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
    throw Object.assign(new Error('limit/offset must be integers'), { code: 'INVALID_QUERY' });
  }
  return { limit, offset };
}

export function createApp(store: Store) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      // Health
      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { status: 'ok' });
      }

      // Cells
      if (req.method === 'POST' && path === '/cells') {
        const body = await readJson(req);
        const stored = store.createCell(
          { a: Number(body.a), b: Number(body.b), c: Number(body.c) } as CellParams,
          (body.atoms ?? []) as Atom[]);
        return send(res, 201, stored);
      }
      if (req.method === 'GET' && path === '/cells') {
        const { limit, offset } = pageParams(url);
        const { items, total } = store.listCells(limit, offset);
        return send(res, 200, { data: items, page: { limit, offset, total } });
      }
      const cellMatch = path.match(/^\/cells\/(\d+)$/);
      if (req.method === 'GET' && cellMatch) {
        const cell = store.getCell(Number(cellMatch[1]));
        return cell ? send(res, 200, cell) : send(res, 404, errorBody('NOT_FOUND', 'cell not found'));
      }

      // Scans
      const scansMatch = path.match(/^\/cells\/(\d+)\/scans$/);
      if (req.method === 'POST' && scansMatch) {
        const body = await readJson(req);
        const requestId = (req.headers['idempotency-key'] as string | undefined) ?? body.requestId;
        const scan = store.runScan(Number(scansMatch[1]), body, requestId);
        return send(res, 201, scan);
      }
      if (req.method === 'GET' && path === '/scans') {
        const { limit, offset } = pageParams(url);
        const cellParam = url.searchParams.get('cellId');
        const cellId = cellParam === null ? null : Number(cellParam);
        const { items, total } = store.listScans(cellId, limit, offset);
        return send(res, 200, { data: items, page: { limit, offset, total } });
      }
      const scanMatch = path.match(/^\/scans\/(\d+)$/);
      if (req.method === 'GET' && scanMatch) {
        const scan = store.getScan(Number(scanMatch[1]));
        if (!scan) return send(res, 404, errorBody('NOT_FOUND', 'scan not found'));
        const { limit, offset } = pageParams(url);
        const kind = url.searchParams.get('kind'); // reflections | excluded | lines
        const arr = kind === 'excluded' ? scan.result.excluded
          : kind === 'lines' ? scan.result.lines
          : scan.result.reflections;
        const slice = arr.slice(offset, offset + limit);
        return send(res, 200, {
          data: slice,
          page: { limit, offset, total: arr.length },
          meta: {
            reportVersion: scan.reportVersion,
            enumeratedTriples: scan.result.enumeratedTriples,
            finiteEnumeration: true,
            note: 'results cover only the finite enumerated Miller box, not all possible reflections',
            millerRange: { h: [scan.params.hMin, scan.params.hMax],
              k: [scan.params.kMin, scan.params.kMax], l: [scan.params.lMin, scan.params.lMax] },
            paramsSnapshot: scan.params,
          },
        });
      }

      // Extinction explanation for a stored scan: /scans/:id/explain?h=&k=&l=
      const explainMatch = path.match(/^\/scans\/(\d+)\/explain$/);
      if (req.method === 'GET' && explainMatch) {
        const scan = store.getScan(Number(explainMatch[1]));
        if (!scan) return send(res, 404, errorBody('NOT_FOUND', 'scan not found'));
        const h = Number(url.searchParams.get('h'));
        const k = Number(url.searchParams.get('k'));
        const l = Number(url.searchParams.get('l'));
        if (![h, k, l].every(Number.isInteger)) {
          return send(res, 400, errorBody('INVALID_QUERY', 'h,k,l must be integers'));
        }
        return send(res, 200, explainExtinction(scan.result, h, k, l));
      }

      return send(res, 404, errorBody('NOT_FOUND', `no route for ${req.method} ${path}`));
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return send(res, 400, errorBody('INVALID_PARAMS', err.message));
      }
      if (err?.code === 'NOT_FOUND') return send(res, 404, errorBody('NOT_FOUND', err.message));
      if (err instanceof SyntaxError) {
        return send(res, 400, errorBody('INVALID_JSON', 'request body was not valid JSON'));
      }
      return send(res, 500, errorBody('INTERNAL', err?.message ?? 'internal error'));
    }
  };
}

// Bind loopback only; port 0 lets the OS assign an ephemeral port. The chosen
// port and pid are written inside the project directory.
export function startServer(dbPath: string, dataDir: string): Promise<{ server: Server; port: number; store: Store }> {
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dbPath);
  const server = createServer(createApp(store));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      writeFileSync(join(dataDir, 'server.json'),
        JSON.stringify({ port, pid: process.pid, host: '127.0.0.1', startedAt: new Date().toISOString() }, null, 2));
      resolve({ server, port, store });
    });
  });
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  const dataDir = join(process.cwd(), 'data');
  startServer(join(dataDir, 'app.db'), dataDir).then(({ port }) => {
    console.log(`powder-diffraction API listening on http://127.0.0.1:${port} (pid ${process.pid})`);
  });
}
