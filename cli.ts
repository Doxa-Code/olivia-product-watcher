#!/usr/bin/env bun
/**
 * Product Watcher - Unified CLI
 *
 * Single binary that handles:
 * - CLI commands (add, list, logs, run, stop, start, remove, config)
 * - Configuration wizard
 * - Sync engine (daemon mode)
 *
 * Usage:
 *   watcher add <name>       Configure and start new client
 *   watcher list             List all clients
 *   watcher logs <name>      View client logs
 *   watcher run <name>       Execute sync
 *   watcher stop <name>      Stop client
 *   watcher start <name>     Start client
 *   watcher remove <name>    Remove client
 *   watcher config <name>    Reconfigure client
 *   watcher daemon           Run in daemon mode (used by Docker)
 */

import Datastore from "@seald-io/nedb";
import axios from "axios";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import mysql from "mysql";
import { Client } from "pg";
import prompts from "prompts";
import readline from "node:readline";

// =============================================================================
// Colors & Styles
// =============================================================================

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

const style = {
  title: (s: string) => `${c.cyan}${c.bold}${s}${c.reset}`,
  subtitle: (s: string) => `${c.dim}${s}${c.reset}`,
  success: (s: string) => `${c.green}${s}${c.reset}`,
  error: (s: string) => `${c.red}${s}${c.reset}`,
  warn: (s: string) => `${c.yellow}${s}${c.reset}`,
  info: (s: string) => `${c.cyan}${s}${c.reset}`,
  highlight: (s: string) => `${c.bold}${s}${c.reset}`,
  dim: (s: string) => `${c.dim}${s}${c.reset}`,
  check: `${c.green}✓${c.reset}`,
  cross: `${c.red}✗${c.reset}`,
  arrow: `${c.cyan}▶${c.reset}`,
};

// =============================================================================
// Config & Constants
// =============================================================================

const WATCHER_DIR = process.env.WATCHER_DIR || `${process.env.HOME}/.watcher`;

const DEST_CONFIG = {
  host: "doxacode.postgres.database.azure.com",
  port: 5432,
  user: "postgres",
  password: "doxa@2021",
  database: "postgres",
  ssl: { rejectUnauthorized: false },
};

// =============================================================================
// Types
// =============================================================================

interface Config {
  instanceName: string;
  source: {
    type: "mysql5" | "mysql8" | "postgres";
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    table: string;
  };
  columns: {
    id: string;
    description: string;
    code: string;
    price: string;
    displayName?: string;
    manufactory?: string;
    stock?: string;
    promotionPrice?: string;
    needPrescription?: string;
  };
  workspaceId: string;
  azure: {
    endpoint: string;
    apiKey: string;
  };
  jina?: {
    apiKey: string;
    concurrency: number;
  };
  batchSize: number;
  staleMinutes: number;
  cron: {
    quickInterval: number;
    fullInterval: number;
  };
}

interface HashEntry {
  id: number;
  hash: string;
  updatedAt: Date;
}

interface Product {
  id: number;
  workspace_id: string;
  description: string;
  display_name: string;
  code: string;
  manufactory: string;
  price: number;
  stock: number;
  promotion_price: number | null;
  promotion_start: Date | null;
  promotion_end: Date | null;
  need_prescription: boolean;
}

interface ProductPayload {
  status: "new" | "changed" | "unchanged";
  hash: string;
  product: Product;
  embedding?: number[];
}

interface Workspace {
  id: string;
  name: string;
}

interface DbConfig {
  type: "mysql5" | "mysql8" | "postgres";
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

// =============================================================================
// Utilities
// =============================================================================

const getClientDir = (name: string): string => path.join(WATCHER_DIR, name);

const clientExists = (name: string): boolean => {
  const dir = getClientDir(name);
  return fs.existsSync(dir) && fs.existsSync(path.join(dir, "config.env"));
};

const sanitizeName = (name: string): string =>
  name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

const isDocker = (): boolean => {
  try {
    return fs.existsSync("/.dockerenv") ||
           fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker");
  } catch {
    return false;
  }
};

const resolveHost = (host: string): string => {
  if (isDocker() && (host === "localhost" || host === "127.0.0.1")) {
    return "host.docker.internal";
  }
  return host;
};

const log = {
  info: (msg: string, data?: object) => {
    const time = new Date().toISOString();
    console.log(`[${time}] INFO  ${msg}`, data ? JSON.stringify(data) : "");
  },
  error: (msg: string, data?: object) => {
    const time = new Date().toISOString();
    console.error(`[${time}] ERROR ${msg}`, data ? JSON.stringify(data) : "");
  },
  progress: (current: number, total: number, msg: string) => {
    const pct = ((current / total) * 100).toFixed(1);
    const time = new Date().toISOString();
    console.log(`[${time}] [${pct}%] ${current}/${total} ${msg}`);
  },
};

// =============================================================================
// Config Loader
// =============================================================================

const loadConfig = (envPath?: string): Config => {
  if (envPath && fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=").replace(/^["']|["']$/g, "");
      process.env[key.trim()] = value;
    }
  }

  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env: ${key}`);
    return val;
  };

  const optional = (key: string, def: string): string => process.env[key] || def;

  return {
    instanceName: optional("INSTANCE_NAME", "default"),
    source: {
      type: optional("SOURCE_TYPE", "mysql5") as "mysql5" | "mysql8" | "postgres",
      host: resolveHost(required("SOURCE_HOST")),
      port: parseInt(optional("SOURCE_PORT", "3306")),
      user: required("SOURCE_USER"),
      password: required("SOURCE_PASS"),
      database: required("SOURCE_DB"),
      table: required("SOURCE_TABLE"),
    },
    columns: {
      id: optional("COL_ID", "id"),
      description: optional("COL_DESC", "descricao"),
      code: optional("COL_CODE", "codigo"),
      price: optional("COL_PRICE", "preco"),
      displayName: process.env.COL_DISPLAY_NAME,
      manufactory: process.env.COL_MANUFACTORY,
      stock: process.env.COL_STOCK,
      promotionPrice: process.env.COL_PROMO_PRICE,
      needPrescription: process.env.COL_PRESCRIPTION,
    },
    workspaceId: required("WORKSPACE_ID"),
    azure: {
      endpoint: optional(
        "AZURE_ENDPOINT",
        "https://doxacode-east-us-2.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-04-01-preview"
      ),
      apiKey: required("AZURE_API_KEY"),
    },
    jina: process.env.JINA_API_KEY
      ? {
          apiKey: process.env.JINA_API_KEY,
          concurrency: parseInt(optional("JINA_CONCURRENCY", "5")),
        }
      : undefined,
    batchSize: parseInt(optional("BATCH_SIZE", "50")),
    staleMinutes: parseInt(optional("STALE_MINUTES", "60")),
    cron: {
      quickInterval: parseInt(optional("CRON_QUICK_MINUTES", "15")),
      fullInterval: parseInt(optional("CRON_FULL_MINUTES", "1440")),
    },
  };
};

// =============================================================================
// Database Helpers
// =============================================================================

const testConnection = async (config: DbConfig): Promise<{ ok: boolean; error?: string }> => {
  if (config.type === "postgres") {
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database || "postgres",
      connectionTimeoutMillis: 10000,
    });
    try {
      await client.connect();
      await client.end();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  } else {
    return new Promise((resolve) => {
      const conn = mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectTimeout: 10000,
        insecureAuth: config.type === "mysql5",
      });
      conn.connect((err) => {
        if (err) {
          resolve({ ok: false, error: err.message });
        } else {
          conn.end();
          resolve({ ok: true });
        }
      });
    });
  }
};

const listDatabases = async (config: DbConfig): Promise<string[]> => {
  if (config.type === "postgres") {
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: "postgres",
    });
    await client.connect();
    const result = await client.query(
      "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
    );
    await client.end();
    return result.rows.map((r: { datname: string }) => r.datname);
  } else {
    return new Promise((resolve, reject) => {
      const conn = mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        insecureAuth: config.type === "mysql5",
      });
      conn.connect((err) => {
        if (err) return reject(err);
        conn.query("SHOW DATABASES", (err, rows: any[]) => {
          conn.end();
          if (err) return reject(err);
          resolve(
            rows
              .map((r) => r.Database)
              .filter((d: string) => !["information_schema", "mysql", "performance_schema", "sys"].includes(d))
          );
        });
      });
    });
  }
};

const listTables = async (config: DbConfig & { database: string }): Promise<string[]> => {
  if (config.type === "postgres") {
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
    });
    await client.connect();
    const result = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    await client.end();
    return result.rows.map((r: { tablename: string }) => r.tablename);
  } else {
    return new Promise((resolve, reject) => {
      const conn = mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        insecureAuth: config.type === "mysql5",
      });
      conn.connect((err) => {
        if (err) return reject(err);
        conn.query("SHOW TABLES", (err, rows: any[]) => {
          conn.end();
          if (err) return reject(err);
          const key = Object.keys(rows[0] || {})[0];
          resolve(rows.map((r) => r[key]));
        });
      });
    });
  }
};

const listColumns = async (config: DbConfig & { database: string; table: string }): Promise<string[]> => {
  if (config.type === "postgres") {
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
    });
    await client.connect();
    const result = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
      [config.table]
    );
    await client.end();
    return result.rows.map((r: { column_name: string }) => r.column_name);
  } else {
    return new Promise((resolve, reject) => {
      const conn = mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        insecureAuth: config.type === "mysql5",
      });
      conn.connect((err) => {
        if (err) return reject(err);
        conn.query(`SHOW COLUMNS FROM \`${config.table}\``, (err, rows: any[]) => {
          conn.end();
          if (err) return reject(err);
          resolve(rows.map((r) => r.Field));
        });
      });
    });
  }
};

const listWorkspaces = async (): Promise<Workspace[]> => {
  const client = new Client({
    host: DEST_CONFIG.host,
    port: DEST_CONFIG.port,
    user: DEST_CONFIG.user,
    password: DEST_CONFIG.password,
    database: DEST_CONFIG.database,
    ssl: DEST_CONFIG.ssl,
  });

  try {
    await client.connect();
    const result = await client.query("SELECT id, name FROM public.workspaces ORDER BY name");
    await client.end();
    return result.rows.map((r: { id: string; name: string }) => ({
      id: r.id,
      name: r.name,
    }));
  } catch (e) {
    try {
      await client.end();
    } catch {}
    throw e;
  }
};

// =============================================================================
// Parallel Pool
// =============================================================================

class ParallelPool<T, R> {
  private index = 0;

  constructor(
    private items: T[],
    private concurrency: number,
    private fn: (item: T, index: number) => Promise<R>
  ) {}

  async run(): Promise<R[]> {
    const results: R[] = new Array(this.items.length);

    const worker = async () => {
      while (this.index < this.items.length) {
        const i = this.index++;
        try {
          results[i] = await this.fn(this.items[i], i);
        } catch {
          results[i] = null as R;
        }
      }
    };

    await Promise.all(
      Array(Math.min(this.concurrency, this.items.length))
        .fill(null)
        .map(() => worker())
    );

    return results;
  }
}

// =============================================================================
// Hash Cache
// =============================================================================

class HashCache {
  private cache = new Map<number, HashEntry>();
  private dirty = new Set<number>();
  private store: Datastore;

  constructor(dataDir: string) {
    const dbPath = `${dataDir}/hashes.db`;
    this.store = new Datastore({ filename: dbPath, autoload: true });
  }

  async load(): Promise<number> {
    const docs = await this.store.findAsync({});
    for (const doc of docs as HashEntry[]) {
      this.cache.set(doc.id, {
        id: doc.id,
        hash: doc.hash,
        updatedAt: new Date(doc.updatedAt),
      });
    }
    return this.cache.size;
  }

  get(id: number): HashEntry | undefined {
    return this.cache.get(id);
  }

  set(id: number, hash: string): void {
    this.cache.set(id, { id, hash, updatedAt: new Date() });
    this.dirty.add(id);
  }

  async persist(): Promise<number> {
    const dirtyEntries = [...this.dirty].map((id) => this.cache.get(id)!);
    if (dirtyEntries.length === 0) return 0;

    for (const entry of dirtyEntries) {
      await this.store.updateAsync(
        { id: entry.id },
        { id: entry.id, hash: entry.hash, updatedAt: entry.updatedAt },
        { upsert: true }
      );
    }

    const count = this.dirty.size;
    this.dirty.clear();
    return count;
  }
}

// =============================================================================
// External APIs
// =============================================================================

const fetchJinaDescription = async (code: string, apiKey: string): Promise<string | null> => {
  try {
    const resp = await axios.get(`https://r.jina.ai/https://go-upc.com/search?q=${code}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });

    const match = resp.data.match(/(?<=^Title:\s)([^\n]+)/m);
    if (!match) return null;

    const title = match[0].trim();
    if (/Product Not Found|Access denied/i.test(title)) return null;

    return title
      .replace(/(EAN\s*\d+\s*[-–—]?\s*|[-–—]?\s*Go-UPC\s*)/gi, "")
      .replace(/[-–—]/g, "")
      .trim();
  } catch {
    return null;
  }
};

const generateEmbeddings = async (texts: string[], config: Config): Promise<number[][]> => {
  const resp = await axios.post(
    config.azure.endpoint,
    { input: texts, dimension: 1536 },
    {
      headers: { "api-key": config.azure.apiKey },
      timeout: 60000,
    }
  );
  return resp.data.data.map((d: { embedding: number[] }) => d.embedding);
};

// =============================================================================
// Data Processing
// =============================================================================

const sanitize = (text: string): string =>
  (text || "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const createHash = (data: string): string =>
  crypto.createHash("sha256").update(data).digest("hex");

const buildQuery = (config: Config): string => {
  const cols = Object.values(config.columns).filter(Boolean);
  return `SELECT ${cols.join(", ")} FROM ${config.source.table}`;
};

// =============================================================================
// Database Connections
// =============================================================================

const createSourceConnection = (config: Config): mysql.Connection => {
  const opts: mysql.ConnectionConfig = {
    host: config.source.host,
    port: config.source.port,
    user: config.source.user,
    password: config.source.password,
    database: config.source.database,
    connectTimeout: 30000,
  };

  if (config.source.type === "mysql5") {
    opts.insecureAuth = true;
  }

  return mysql.createConnection(opts);
};

const createDestClient = async (): Promise<Client> => {
  const client = new Client({
    host: DEST_CONFIG.host,
    port: DEST_CONFIG.port,
    user: DEST_CONFIG.user,
    password: DEST_CONFIG.password,
    database: DEST_CONFIG.database,
    ssl: DEST_CONFIG.ssl,
  });
  await client.connect();
  return client;
};

// =============================================================================
// Sync Engine
// =============================================================================

const runSync = async (config: Config, mode: "full" | "quick"): Promise<void> => {
  const startTime = Date.now();
  const dataDir = `./${config.instanceName}`;

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  log.info(`Starting sync`, { mode, instance: config.instanceName });

  const hashCache = new HashCache(dataDir);
  const existingHashes = await hashCache.load();
  log.info(`Loaded hash cache`, { entries: existingHashes });

  log.info(`Connecting to source...`, { host: config.source.host, port: config.source.port });
  const source = createSourceConnection(config);

  try {
    await new Promise<void>((resolve, reject) => {
      source.connect((err) => {
        if (err) {
          log.error(`Source connection failed`, {
            error: err.message,
            code: err.code,
            errno: err.errno,
          });
          reject(err);
        } else {
          resolve();
        }
      });
    });
  } catch (e) {
    const err = e as any;
    throw new Error(`Failed to connect to source database: ${err.message || err.code || "Unknown error"}`);
  }

  log.info(`Connected to source`, { host: config.source.host, db: config.source.database });

  const countResult = await new Promise<number>((resolve, reject) => {
    source.query(`SELECT COUNT(*) as total FROM ${config.source.table}`, (err, rows: any) => {
      err ? reject(err) : resolve(rows[0].total);
    });
  });
  log.info(`Total products in source`, { count: countResult });

  const query = buildQuery(config);
  const allRows = await new Promise<any[]>((resolve, reject) => {
    source.query(query, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
  source.end();
  log.info(`Fetched all products`, { count: allRows.length });

  const staleMs = config.staleMinutes * 60 * 1000;
  const now = Date.now();
  const cols = config.columns;

  const products: ProductPayload[] = [];
  let skipped = 0;

  for (const row of allRows) {
    const productId = row[cols.id];
    const currentHash = createHash(Object.values(row).join("|"));
    const existing = hashCache.get(productId);

    if (mode === "quick" && existing) {
      const age = now - new Date(existing.updatedAt).getTime();
      if (age < staleMs && existing.hash === currentHash) {
        skipped++;
        continue;
      }
    }

    if (mode === "full" && existing?.hash === currentHash) {
      skipped++;
      continue;
    }

    const price = Number(row[cols.price]) * 100;
    const promoPrice = cols.promotionPrice ? Number(row[cols.promotionPrice]) * 100 : null;
    const hasPromo = promoPrice && promoPrice !== price;

    const description = sanitize(row[cols.description]);

    products.push({
      status: existing ? "changed" : "new",
      hash: currentHash,
      product: {
        id: productId,
        workspace_id: config.workspaceId,
        description,
        display_name: cols.displayName ? sanitize(row[cols.displayName]) : description,
        code: String(row[cols.code] || ""),
        manufactory: cols.manufactory ? String(row[cols.manufactory] || "") : "",
        price,
        stock: cols.stock ? Number(row[cols.stock]) || 0 : 0,
        promotion_price: hasPromo ? promoPrice : null,
        promotion_start: hasPromo ? new Date() : null,
        promotion_end: hasPromo ? new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000) : null,
        need_prescription: cols.needPrescription ? row[cols.needPrescription] === 1 : false,
      },
    });
  }

  log.info(`Products to process`, {
    total: allRows.length,
    toProcess: products.length,
    skipped,
    new: products.filter((p) => p.status === "new").length,
    changed: products.filter((p) => p.status === "changed").length,
  });

  if (products.length === 0) {
    log.info(`No products to sync`);
    return;
  }

  const newProducts = products.filter((p) => p.status === "new");
  if (config.jina && newProducts.length > 0) {
    log.info(`Starting Jina lookups`, { count: newProducts.length, concurrency: config.jina.concurrency });

    const descriptions = await new ParallelPool(newProducts, config.jina.concurrency, async (p, i) => {
      if (i % 50 === 0) {
        log.progress(i, newProducts.length, "Jina lookups");
      }
      return fetchJinaDescription(p.product.code, config.jina!.apiKey);
    }).run();

    for (let i = 0; i < newProducts.length; i++) {
      if (descriptions[i]) {
        newProducts[i].product.display_name = descriptions[i]!;
      }
    }

    log.info(`Jina lookups complete`, { found: descriptions.filter(Boolean).length });
  }

  const needEmbedding = products.filter((p) => p.status === "new");
  log.info(`Generating embeddings`, { count: needEmbedding.length, batchSize: config.batchSize });

  for (let i = 0; i < needEmbedding.length; i += config.batchSize) {
    const batch = needEmbedding.slice(i, i + config.batchSize);
    const texts = batch.map((p) => p.product.display_name || p.product.description);

    try {
      const embeddings = await generateEmbeddings(texts, config);
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = embeddings[j];
      }
      log.progress(Math.min(i + config.batchSize, needEmbedding.length), needEmbedding.length, "embeddings generated");
    } catch (e) {
      log.error(`Embedding batch failed`, { batch: i, error: (e as Error).message });
    }
  }

  const dest = await createDestClient();
  log.info(`Connected to destination`);

  const withEmbedding = products.filter((p) => p.embedding);
  const withoutEmbedding = products.filter((p) => !p.embedding && p.status === "changed");

  if (withEmbedding.length > 0) {
    log.info(`Upserting products with embeddings`, { count: withEmbedding.length });

    for (let i = 0; i < withEmbedding.length; i += config.batchSize) {
      const batch = withEmbedding.slice(i, i + config.batchSize);

      const ids = batch.map((p) => String(p.product.id));
      const workspaceIds = batch.map((p) => p.product.workspace_id);
      const descriptions = batch.map((p) => p.product.description);
      const displayNames = batch.map((p) => p.product.display_name);
      const codes = batch.map((p) => p.product.code);
      const manufactories = batch.map((p) => p.product.manufactory);
      const prices = batch.map((p) => p.product.price);
      const promosPrices = batch.map((p) => p.product.promotion_price);
      const promosStarts = batch.map((p) => p.product.promotion_start);
      const promosEnds = batch.map((p) => p.product.promotion_end);
      const stocks = batch.map((p) => p.product.stock);
      const prescriptions = batch.map((p) => p.product.need_prescription);
      const embeddings = batch.map((p) => JSON.stringify(p.embedding));

      await dest.query(
        `INSERT INTO public.products (id, workspace_id, description, display_name, code, manufactory, price, promotion_price, promotion_start, promotion_end, stock, need_prescription, embedding)
         SELECT * FROM UNNEST($1::text[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::timestamp[], $10::timestamp[], $11::int[], $12::boolean[], $13::vector[])
         ON CONFLICT (id, workspace_id) DO UPDATE SET
           description = EXCLUDED.description, display_name = EXCLUDED.display_name, code = EXCLUDED.code,
           manufactory = EXCLUDED.manufactory, price = EXCLUDED.price, promotion_price = EXCLUDED.promotion_price,
           promotion_start = EXCLUDED.promotion_start, promotion_end = EXCLUDED.promotion_end, stock = EXCLUDED.stock,
           need_prescription = EXCLUDED.need_prescription, embedding = EXCLUDED.embedding`,
        [ids, workspaceIds, descriptions, displayNames, codes, manufactories, prices, promosPrices, promosStarts, promosEnds, stocks, prescriptions, embeddings]
      );

      // Persist hashes immediately after successful batch insert
      for (const p of batch) {
        hashCache.set(p.product.id, p.hash);
      }
      await hashCache.persist();

      log.progress(Math.min(i + config.batchSize, withEmbedding.length), withEmbedding.length, "upserted with embedding");
    }
  }

  if (withoutEmbedding.length > 0) {
    log.info(`Updating products (data only)`, { count: withoutEmbedding.length });

    for (let i = 0; i < withoutEmbedding.length; i += config.batchSize) {
      const batch = withoutEmbedding.slice(i, i + config.batchSize);

      const ids = batch.map((p) => String(p.product.id));
      const workspaceIds = batch.map((p) => p.product.workspace_id);
      const descriptions = batch.map((p) => p.product.description);
      const displayNames = batch.map((p) => p.product.display_name);
      const codes = batch.map((p) => p.product.code);
      const manufactories = batch.map((p) => p.product.manufactory);
      const prices = batch.map((p) => p.product.price);
      const promosPrices = batch.map((p) => p.product.promotion_price);
      const promosStarts = batch.map((p) => p.product.promotion_start);
      const promosEnds = batch.map((p) => p.product.promotion_end);
      const stocks = batch.map((p) => p.product.stock);
      const prescriptions = batch.map((p) => p.product.need_prescription);

      await dest.query(
        `UPDATE public.products AS p SET
           description = u.description, display_name = u.display_name, code = u.code, manufactory = u.manufactory,
           price = u.price, promotion_price = u.promotion_price, promotion_start = u.promotion_start,
           promotion_end = u.promotion_end, stock = u.stock, need_prescription = u.need_prescription
         FROM (SELECT * FROM UNNEST($1::text[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::timestamp[], $10::timestamp[], $11::int[], $12::boolean[])
           AS t(id, workspace_id, description, display_name, code, manufactory, price, promotion_price, promotion_start, promotion_end, stock, need_prescription)) AS u
         WHERE p.id = u.id AND p.workspace_id = u.workspace_id`,
        [ids, workspaceIds, descriptions, displayNames, codes, manufactories, prices, promosPrices, promosStarts, promosEnds, stocks, prescriptions]
      );

      // Persist hashes immediately after successful batch update
      for (const p of batch) {
        hashCache.set(p.product.id, p.hash);
      }
      await hashCache.persist();

      log.progress(Math.min(i + config.batchSize, withoutEmbedding.length), withoutEmbedding.length, "updated (data only)");
    }
  }

  await dest.end();
  log.info(`Hashes persisted incrementally during sync`);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Sync complete`, {
    duration: `${duration}s`,
    processed: products.length,
    withEmbedding: withEmbedding.length,
    dataOnly: withoutEmbedding.length,
    skipped,
  });
};

// =============================================================================
// Daemon Mode
// =============================================================================

const runDaemon = async (): Promise<void> => {
  const config = loadConfig();

  log.info(`Starting daemon mode`, {
    quickEvery: `${config.cron.quickInterval}m`,
    fullEvery: `${config.cron.fullInterval}m`,
  });

  let lastQuickRun = 0;
  let lastFullRun = 0;

  log.info(`Initial full sync...`);
  await runSync(config, "full");
  lastFullRun = Date.now();
  lastQuickRun = Date.now();

  while (true) {
    const now = Date.now();
    const quickIntervalMs = config.cron.quickInterval * 60 * 1000;
    const fullIntervalMs = config.cron.fullInterval * 60 * 1000;

    if (config.cron.fullInterval > 0 && now - lastFullRun >= fullIntervalMs) {
      log.info(`Scheduled full sync`);
      await runSync(config, "full");
      lastFullRun = Date.now();
      lastQuickRun = Date.now();
    } else if (config.cron.quickInterval > 0 && now - lastQuickRun >= quickIntervalMs) {
      log.info(`Scheduled quick sync`);
      await runSync(config, "quick");
      lastQuickRun = Date.now();
    }

    await new Promise((r) => setTimeout(r, 60 * 1000));
  }
};

// =============================================================================
// Configuration Wizard
// =============================================================================

const printBanner = (clientName: string) => {
  console.log();
  console.log(`${c.cyan}${c.bold}`);
  console.log("  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║              PRODUCT WATCHER                             ║");
  console.log("  ╚══════════════════════════════════════════════════════════╝");
  console.log(`${c.reset}`);
  console.log();
  console.log(`  ${style.subtitle("Configuração de Novo Cliente")}`);
  console.log(`  ${style.highlight(clientName)}`);
  console.log();
};

const printSection = (title: string, subtitle?: string) => {
  console.log();
  console.log(`  ${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`  ${style.title(title)}`);
  if (subtitle) {
    console.log(`  ${style.subtitle(subtitle)}`);
  }
  console.log(`  ${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log();
};

const runWizard = async (clientName: string, clientDir: string): Promise<boolean> => {
  printBanner(clientName);

  const onCancel = () => {
    console.log();
    console.log(`  ${style.warn("Configuração cancelada.")}`);
    console.log();
    process.exit(1);
  };

  // STEP 1: Database Type
  printSection("1. Banco de Dados de Origem", "Onde estão seus produtos");

  const dbTypeRes = await prompts(
    {
      type: "select",
      name: "type",
      message: "Tipo do banco de dados",
      choices: [
        { title: `${c.green}●${c.reset} MySQL 5.x`, description: "Versão antiga com autenticação insegura", value: "mysql5" },
        { title: `${c.blue}●${c.reset} MySQL 8.x`, description: "Versão moderna com caching_sha2", value: "mysql8" },
        { title: `${c.magenta}●${c.reset} PostgreSQL`, description: "Banco PostgreSQL", value: "postgres" },
      ],
      initial: 0,
    },
    { onCancel }
  );

  // STEP 2: Connection Details
  printSection("2. Conexão com o Banco", "Informe os dados de acesso");

  const defaultPort = dbTypeRes.type === "postgres" ? 5432 : 3306;

  const connRes = await prompts(
    [
      { type: "text", name: "host", message: "Host", initial: "localhost" },
      { type: "number", name: "port", message: "Porta", initial: defaultPort },
      { type: "text", name: "user", message: "Usuário", validate: (v) => v.length > 0 || "Obrigatório" },
      { type: "password", name: "password", message: "Senha" },
    ],
    { onCancel }
  );

  // STEP 3: Test Connection
  console.log();
  process.stdout.write(`  ${style.info("▶")} Testando conexão...`);

  const dbConfig: DbConfig = {
    type: dbTypeRes.type,
    host: connRes.host,
    port: connRes.port,
    user: connRes.user,
    password: connRes.password,
  };

  const testResult = await testConnection(dbConfig);

  if (!testResult.ok) {
    console.log(` ${style.cross}`);
    console.log();
    console.log(`  ${style.error("Erro de conexão:")} ${testResult.error}`);
    console.log();
    return false;
  }

  console.log(` ${style.check}`);

  // STEP 4: Select Database
  printSection("3. Selecione o Database", "Escolha ou digite o nome do database");

  process.stdout.write(`  ${style.info("▶")} Carregando databases...`);
  let databases: string[] = [];
  try {
    databases = await listDatabases(dbConfig);
    console.log(` ${style.check} (${databases.length} encontrados)`);
  } catch {
    console.log(` ${style.cross}`);
    console.log(`  ${style.warn("Não foi possível listar databases. Digite manualmente.")}`);
  }
  console.log();

  const dbRes = await prompts(
    {
      type: databases.length > 0 ? "autocomplete" : "text",
      name: "database",
      message: "Database",
      choices: databases.map((d) => ({ title: d, value: d })),
      suggest: (input, choices) => choices.filter((c) => c.title.toLowerCase().includes(input.toLowerCase())),
      validate: (v) => v.length > 0 || "Obrigatório",
    },
    { onCancel }
  );

  // STEP 5: Select Table
  printSection("4. Tabela de Produtos", "Onde estão os dados dos produtos");

  process.stdout.write(`  ${style.info("▶")} Carregando tabelas...`);
  let tables: string[] = [];
  try {
    tables = await listTables({ ...dbConfig, database: dbRes.database });
    console.log(` ${style.check} (${tables.length} encontradas)`);
  } catch {
    console.log(` ${style.cross}`);
    console.log(`  ${style.warn("Não foi possível listar tabelas. Digite manualmente.")}`);
  }
  console.log();

  const tableRes = await prompts(
    {
      type: tables.length > 0 ? "autocomplete" : "text",
      name: "table",
      message: "Tabela de produtos",
      choices: tables.map((t) => ({ title: t, value: t })),
      suggest: (input, choices) => choices.filter((c) => c.title.toLowerCase().includes(input.toLowerCase())),
      validate: (v) => v.length > 0 || "Obrigatório",
    },
    { onCancel }
  );

  // STEP 6: Column Mapping
  printSection("5. Mapeamento de Colunas", "Qual coluna corresponde a cada campo");

  process.stdout.write(`  ${style.info("▶")} Carregando colunas...`);
  let columns: string[] = [];
  try {
    columns = await listColumns({ ...dbConfig, database: dbRes.database, table: tableRes.table });
    console.log(` ${style.check} (${columns.length} encontradas)`);
  } catch {
    console.log(` ${style.cross}`);
    console.log(`  ${style.warn("Não foi possível listar colunas. Digite manualmente.")}`);
  }
  console.log();

  const columnChoices = columns.map((col) => ({ title: col, value: col }));

  const makeColumnPrompt = (name: string, label: string, required: boolean) => ({
    type: columns.length > 0 ? ("autocomplete" as const) : ("text" as const),
    name,
    message: `${label}${required ? "" : " (opcional)"}`,
    choices: columnChoices,
    suggest: (input: string, choices: any[]) => choices.filter((c) => c.title.toLowerCase().includes(input.toLowerCase())),
    validate: required ? (v: string) => v.length > 0 || "Obrigatório" : undefined,
  });

  console.log(`  ${style.subtitle("Colunas obrigatórias:")}`);
  console.log();

  const requiredCols = await prompts(
    [
      makeColumnPrompt("id", "ID do produto", true),
      makeColumnPrompt("desc", "Descrição", true),
      makeColumnPrompt("code", "Código de barras", true),
      makeColumnPrompt("price", "Preço", true),
    ],
    { onCancel }
  );

  console.log();
  console.log(`  ${style.subtitle("Colunas opcionais:")}`);
  console.log();

  const optionalCols = await prompts(
    [
      makeColumnPrompt("displayName", "Nome de exibição", false),
      makeColumnPrompt("manufactory", "Fabricante", false),
      makeColumnPrompt("stock", "Estoque", false),
      makeColumnPrompt("promoPrice", "Preço promoção", false),
      makeColumnPrompt("needPrescription", "Precisa receita (0/1)", false),
    ],
    { onCancel }
  );

  // STEP 7: Sync Settings
  printSection("6. Configuração de Sync", "Workspace e chaves de API");

  process.stdout.write(`  ${style.info("▶")} Carregando workspaces...`);
  let workspaces: Workspace[] = [];
  try {
    workspaces = await listWorkspaces();
    console.log(` ${style.check} (${workspaces.length} encontrados)`);
  } catch {
    console.log(` ${style.cross}`);
    console.log(`  ${style.warn("Não foi possível listar workspaces. Digite o UUID manualmente.")}`);
  }
  console.log();

  let workspaceRes: { workspaceId: string };

  if (workspaces.length > 0) {
    const workspaceChoices = workspaces.map((w) => ({
      title: `${w.name}`,
      description: w.id,
      value: w.id,
    }));

    workspaceRes = await prompts(
      {
        type: "autocomplete",
        name: "workspaceId",
        message: "Selecione o Workspace",
        choices: workspaceChoices,
        suggest: (input, choices) =>
          choices.filter((c) => c.title.toLowerCase().includes(input.toLowerCase()) || c.description?.toLowerCase().includes(input.toLowerCase())),
      },
      { onCancel }
    );
  } else {
    workspaceRes = await prompts(
      {
        type: "text",
        name: "workspaceId",
        message: "Workspace ID (UUID)",
        validate: (v) => {
          if (!v) return "Obrigatório";
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          return uuidRegex.test(v) || "Formato UUID inválido";
        },
      },
      { onCancel }
    );
  }

  const azureRes = await prompts(
    [
      {
        type: "text",
        name: "azureEndpoint",
        message: "Azure OpenAI Endpoint",
        initial:
          "https://doxacode-east-us-2.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-04-01-preview",
        validate: (v) => v.length > 0 || "Obrigatório",
      },
      {
        type: "password",
        name: "azureApiKey",
        message: "Azure OpenAI API Key",
        validate: (v) => v.length > 0 || "Obrigatório",
      },
    ],
    { onCancel }
  );

  const syncRes = { ...workspaceRes, ...azureRes };

  // STEP 8: Jina (Optional)
  printSection("7. Busca de Descrições (Jina)", "Opcional: melhora descrições de produtos");

  const jinaRes = await prompts(
    [
      {
        type: "confirm",
        name: "enableJina",
        message: "Habilitar busca de descrições via Jina?",
        initial: false,
      },
      {
        type: (prev) => (prev ? "password" : null),
        name: "jinaApiKey",
        message: "Jina API Key",
      },
    ],
    { onCancel }
  );

  // STEP 9: Cron Schedule
  printSection("8. Agendamento de Sync", "Intervalos para sincronização automática");

  const cronRes = await prompts(
    [
      {
        type: "number",
        name: "quickMinutes",
        message: "Intervalo sync rápido (minutos)",
        initial: 15,
        min: 1,
      },
      {
        type: "number",
        name: "fullMinutes",
        message: "Intervalo sync completo (minutos)",
        initial: 1440,
        min: 60,
      },
    ],
    { onCancel }
  );

  // SAVE CONFIG
  printSection("9. Salvando Configuração", "");

  const configContent = `# Product Watcher - Configuração
# Cliente: ${clientName}
# Gerado em: ${new Date().toISOString()}

INSTANCE_NAME=${clientName}

# Banco de Dados Origem
SOURCE_TYPE=${dbTypeRes.type}
SOURCE_HOST=${connRes.host}
SOURCE_PORT=${connRes.port}
SOURCE_USER=${connRes.user}
SOURCE_PASS=${connRes.password}
SOURCE_DB=${dbRes.database}
SOURCE_TABLE=${tableRes.table}

# Workspace
WORKSPACE_ID=${syncRes.workspaceId}

# Azure OpenAI
AZURE_ENDPOINT=${syncRes.azureEndpoint}
AZURE_API_KEY=${syncRes.azureApiKey}

# Mapeamento de Colunas
COL_ID=${requiredCols.id}
COL_DESC=${requiredCols.desc}
COL_CODE=${requiredCols.code}
COL_PRICE=${requiredCols.price}
${optionalCols.displayName ? `COL_DISPLAY_NAME=${optionalCols.displayName}` : "# COL_DISPLAY_NAME="}
${optionalCols.manufactory ? `COL_MANUFACTORY=${optionalCols.manufactory}` : "# COL_MANUFACTORY="}
${optionalCols.stock ? `COL_STOCK=${optionalCols.stock}` : "# COL_STOCK="}
${optionalCols.promoPrice ? `COL_PROMO_PRICE=${optionalCols.promoPrice}` : "# COL_PROMO_PRICE="}
${optionalCols.needPrescription ? `COL_PRESCRIPTION=${optionalCols.needPrescription}` : "# COL_PRESCRIPTION="}

# Jina (Busca de Descrições)
${jinaRes.enableJina && jinaRes.jinaApiKey ? `JINA_API_KEY=${jinaRes.jinaApiKey}` : "# JINA_API_KEY="}
JINA_CONCURRENCY=5

# Performance
BATCH_SIZE=50
STALE_MINUTES=60

# Agendamento (Cron)
CRON_QUICK_MINUTES=${cronRes.quickMinutes}
CRON_FULL_MINUTES=${cronRes.fullMinutes}
`;

  if (!fs.existsSync(clientDir)) {
    fs.mkdirSync(clientDir, { recursive: true });
  }

  const configPath = path.join(clientDir, "config.env");
  fs.writeFileSync(configPath, configContent);

  console.log(`  ${style.check} Configuração salva em ${style.highlight(configPath)}`);
  console.log();

  // SUCCESS
  console.log(`${c.green}${c.bold}`);
  console.log("  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║            ✓  CONFIGURAÇÃO CONCLUÍDA!                    ║");
  console.log("  ╚══════════════════════════════════════════════════════════╝");
  console.log(`${c.reset}`);
  console.log();

  return true;
};

// =============================================================================
// Docker Compose Generator
// =============================================================================

const DOCKER_IMAGE = process.env.WATCHER_IMAGE || "ghcr.io/doxacode/watcher:latest";

const createDockerCompose = (name: string, clientDir: string): void => {
  const content = `services:
  watcher:
    container_name: watcher-${name}
    image: ${DOCKER_IMAGE}
    env_file:
      - config.env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
`;

  fs.writeFileSync(path.join(clientDir, "docker-compose.yml"), content);
};

// =============================================================================
// CLI Commands
// =============================================================================

const showHelp = () => {
  console.log(`
${c.bold}Product Watcher${c.reset}

${c.bold}Uso:${c.reset} watcher <comando> [opções]

${c.bold}Comandos:${c.reset}
  add <nome>           Configurar e iniciar novo cliente
  list                 Listar todos os clientes
  logs <nome>          Ver logs do cliente
  run <nome> [modo]    Executar sync (full|quick)
  stop <nome>          Parar cliente
  start <nome>         Iniciar cliente
  remove <nome>        Remover cliente
  config <nome>        Reconfigurar cliente
  daemon               Executar em modo daemon (usado pelo Docker)

${c.bold}Exemplos:${c.reset}
  watcher add farmacia-centro
  watcher logs farmacia-centro
  watcher run farmacia-centro quick
`);
};

const cmdList = () => {
  console.log();
  console.log(`${c.bold}Clientes${c.reset}`);
  console.log(`${c.dim}─────────────────────────────────────${c.reset}`);

  if (!fs.existsSync(WATCHER_DIR)) {
    console.log(`  ${c.dim}Nenhum cliente configurado.${c.reset}`);
    console.log();
    return;
  }

  const dirs = fs.readdirSync(WATCHER_DIR).filter((d) => {
    const fullPath = path.join(WATCHER_DIR, d);
    return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, "config.env"));
  });

  if (dirs.length === 0) {
    console.log(`  ${c.dim}Nenhum cliente configurado.${c.reset}`);
    console.log();
    return;
  }

  console.log(`  ${c.bold}${"NOME".padEnd(25)} STATUS${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(25)} ${"─".repeat(12)}${c.reset}`);

  for (const name of dirs) {
    try {
      const result = execSync(`docker ps -q -f "name=watcher-${name}"`, { encoding: "utf-8" }).trim();
      if (result) {
        console.log(`  ${name.padEnd(25)} ${c.green}● rodando${c.reset}`);
      } else {
        console.log(`  ${name.padEnd(25)} ${c.yellow}○ parado${c.reset}`);
      }
    } catch {
      console.log(`  ${name.padEnd(25)} ${c.yellow}○ parado${c.reset}`);
    }
  }
  console.log();
};

const cmdAdd = async (name: string) => {
  if (!name) {
    console.error(`${c.red}Erro: Nome do cliente é obrigatório${c.reset}`);
    console.log("Uso: watcher add <nome>");
    process.exit(1);
  }

  name = sanitizeName(name);
  const clientDir = getClientDir(name);

  if (clientExists(name)) {
    console.error(`${c.red}Erro: Cliente '${name}' já existe${c.reset}`);
    console.log("Use: watcher config " + name + " (reconfigurar)");
    console.log("Use: watcher remove " + name + " (remover)");
    process.exit(1);
  }

  fs.mkdirSync(clientDir, { recursive: true });

  const success = await runWizard(name, clientDir);

  if (!success || !fs.existsSync(path.join(clientDir, "config.env"))) {
    console.error(`${c.red}Configuração cancelada.${c.reset}`);
    fs.rmSync(clientDir, { recursive: true, force: true });
    process.exit(1);
  }

  createDockerCompose(name, clientDir);

  console.log(`\n${c.cyan}▶ Iniciando container...${c.reset}`);

  try {
    execSync("docker compose up -d --build", { cwd: clientDir, stdio: "inherit" });
  } catch {
    console.error(`${c.red}Erro ao iniciar container${c.reset}`);
    process.exit(1);
  }

  console.log();
  console.log(`${c.green}════════════════════════════════════════${c.reset}`);
  console.log(`${c.green}          Cliente Configurado!          ${c.reset}`);
  console.log(`${c.green}════════════════════════════════════════${c.reset}`);
  console.log();
  console.log(`Cliente: ${c.bold}${name}${c.reset}`);
  console.log(`Status:  ${c.green}● rodando${c.reset}`);
  console.log();
  console.log(`${c.bold}Comandos:${c.reset}`);
  console.log(`  watcher logs ${name}       # Ver logs`);
  console.log(`  watcher run ${name} quick  # Sync rápido`);
  console.log(`  watcher run ${name} full   # Sync completo`);
  console.log(`  watcher stop ${name}       # Parar`);
  console.log();
};

const cmdLogs = (name: string) => {
  if (!name) {
    console.error(`${c.red}Erro: Informe o nome do cliente${c.reset}`);
    process.exit(1);
  }

  if (!clientExists(name)) {
    console.error(`${c.red}Erro: Cliente '${name}' não encontrado${c.reset}`);
    process.exit(1);
  }

  const clientDir = getClientDir(name);

  try {
    execSync("docker compose logs -f --tail=100", { cwd: clientDir, stdio: "inherit" });
  } catch {
    // User pressed Ctrl+C
  }
};

const cmdRun = (name: string, mode: string = "full") => {
  if (!name) {
    console.error(`${c.red}Erro: Informe o nome do cliente${c.reset}`);
    process.exit(1);
  }

  if (!clientExists(name)) {
    console.error(`${c.red}Erro: Cliente '${name}' não encontrado${c.reset}`);
    process.exit(1);
  }

  const clientDir = getClientDir(name);

  // Check if container is running
  try {
    const result = execSync(`docker compose ps --status running 2>/dev/null | grep watcher`, {
      cwd: clientDir,
      encoding: "utf-8",
    });
    if (!result) throw new Error("not running");
  } catch {
    console.log(`${c.yellow}Container não está rodando. Iniciando...${c.reset}`);
    execSync("docker compose up -d", { cwd: clientDir, stdio: "inherit" });
    execSync("sleep 2");
  }

  console.log(`${c.cyan}Executando sync (${mode}) para ${name}...${c.reset}`);

  try {
    execSync(`docker compose exec watcher bun run /app/watcher --mode ${mode}`, {
      cwd: clientDir,
      stdio: "inherit",
    });
  } catch {
    console.error(`${c.red}Erro ao executar sync${c.reset}`);
    process.exit(1);
  }
};

const cmdStop = (name: string) => {
  if (!name) {
    console.error(`${c.red}Erro: Informe o nome do cliente${c.reset}`);
    process.exit(1);
  }

  if (!clientExists(name)) {
    console.error(`${c.red}Erro: Cliente '${name}' não encontrado${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.yellow}Parando ${name}...${c.reset}`);

  try {
    execSync("docker compose down", { cwd: getClientDir(name), stdio: "inherit" });
    console.log(`${c.green}✓ Parado${c.reset}`);
  } catch {
    console.error(`${c.red}Erro ao parar container${c.reset}`);
    process.exit(1);
  }
};

const cmdStart = (name: string) => {
  if (!name) {
    console.error(`${c.red}Erro: Informe o nome do cliente${c.reset}`);
    process.exit(1);
  }

  if (!clientExists(name)) {
    console.error(`${c.red}Erro: Cliente '${name}' não encontrado${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.cyan}Iniciando ${name}...${c.reset}`);

  try {
    execSync("docker compose up -d", { cwd: getClientDir(name), stdio: "inherit" });
    console.log(`${c.green}✓ Iniciado${c.reset}`);
  } catch {
    console.error(`${c.red}Erro ao iniciar container${c.reset}`);
    process.exit(1);
  }
};

const cmdRemove = async (name: string) => {
  if (!name) {
    console.error(`${c.red}Erro: Informe o nome do cliente${c.reset}`);
    process.exit(1);
  }

  if (!clientExists(name)) {
    console.error(`${c.red}Erro: Cliente '${name}' não encontrado${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.yellow}Isso vai remover o cliente '${name}' e todos os dados.${c.reset}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question("Tem certeza? (s/N): ", resolve);
  });
  rl.close();

  if (!answer.toLowerCase().startsWith("s")) {
    console.log("Cancelado.");
    process.exit(0);
  }

  const clientDir = getClientDir(name);

  console.log("Parando container...");
  try {
    execSync("docker compose down -v 2>/dev/null", { cwd: clientDir });
  } catch {}

  console.log("Removendo arquivos...");
  fs.rmSync(clientDir, { recursive: true, force: true });

  console.log(`${c.green}✓ Cliente '${name}' removido${c.reset}`);
};

const cmdConfig = async (name: string) => {
  if (!name) {
    console.error(`${c.red}Erro: Informe o nome do cliente${c.reset}`);
    process.exit(1);
  }

  if (!clientExists(name)) {
    console.error(`${c.red}Erro: Cliente '${name}' não encontrado${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.cyan}Reconfigurando ${name}...${c.reset}`);

  const clientDir = getClientDir(name);
  const success = await runWizard(name, clientDir);

  if (!success || !fs.existsSync(path.join(clientDir, "config.env"))) {
    console.error(`${c.red}Configuração cancelada.${c.reset}`);
    process.exit(1);
  }

  createDockerCompose(name, clientDir);

  // Restart if running
  try {
    const result = execSync(`docker ps -q -f "name=watcher-${name}"`, { encoding: "utf-8" }).trim();
    if (result) {
      console.log(`${c.cyan}Reiniciando container...${c.reset}`);
      execSync("docker compose down 2>/dev/null", { cwd: clientDir });
      execSync("docker compose up -d --build", { cwd: clientDir, stdio: "inherit" });
    }
  } catch {}

  console.log(`${c.green}✓ Reconfigurado${c.reset}`);
};

// =============================================================================
// Main
// =============================================================================

const main = async () => {
  const args = process.argv.slice(2);
  const command = args[0] || "";

  // Ensure watcher directory exists
  fs.mkdirSync(WATCHER_DIR, { recursive: true });

  switch (command) {
    case "add":
      await cmdAdd(args[1]);
      break;
    case "list":
    case "ls":
      cmdList();
      break;
    case "logs":
    case "log":
      cmdLogs(args[1]);
      break;
    case "run":
    case "sync":
      cmdRun(args[1], args[2]);
      break;
    case "stop":
      cmdStop(args[1]);
      break;
    case "start":
      cmdStart(args[1]);
      break;
    case "remove":
    case "rm":
      await cmdRemove(args[1]);
      break;
    case "config":
      await cmdConfig(args[1]);
      break;
    case "daemon":
      await runDaemon();
      break;
    case "--mode": {
      // Direct sync mode (used inside Docker)
      const mode = args[1] as "full" | "quick";
      const config = loadConfig();
      await runSync(config, mode || "full");
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case "":
      showHelp();
      break;
    default:
      console.error(`${c.red}Comando desconhecido: ${command}${c.reset}`);
      showHelp();
      process.exit(1);
  }
};

main().catch((e) => {
  log.error("Fatal error", { error: (e as Error).message, stack: (e as Error).stack?.split("\n").slice(0, 3).join(" | ") });
  process.exit(1);
});
