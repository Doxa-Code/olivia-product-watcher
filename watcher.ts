#!/usr/bin/env bun
/**
 * Product Watcher - High Performance Sync
 *
 * Usage:
 *   watcher --env cliente.env --mode quick
 *   watcher --env cliente.env --mode full
 *   watcher --env cliente.env --daemon
 */

import Datastore from "@seald-io/nedb";
import axios from "axios";
import crypto from "node:crypto";
import fs from "node:fs";
import mysql from "mysql";
import { Client } from "pg";

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
    quickInterval: number; // minutes between quick syncs (0 = disabled)
    fullInterval: number;  // minutes between full syncs (0 = disabled)
  };
}

interface HashEntry {
  id: number;
  hash: string;
  updatedAt: Date;
  dirty?: boolean;
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
  lookupDescription?: string;
}

// =============================================================================
// Config
// =============================================================================

const DEST_CONFIG = {
  host: "doxacode.postgres.database.azure.com",
  port: 5432,
  user: "postgres",
  password: "doxa@2021",
  database: "postgres",
  ssl: { rejectUnauthorized: false },
};

// Detect if running inside Docker
const isDocker = (): boolean => {
  try {
    return fs.existsSync('/.dockerenv') || fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker');
  } catch {
    return false;
  }
};

// Replace localhost with host.docker.internal when in Docker
const resolveHost = (host: string): string => {
  if (isDocker() && (host === 'localhost' || host === '127.0.0.1')) {
    return 'host.docker.internal';
  }
  return host;
};

const loadConfig = (envPath?: string): Config => {
  // Load .env file if provided
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
      type: (optional("SOURCE_TYPE", "mysql5") as "mysql5" | "mysql8" | "postgres"),
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
      endpoint: optional("AZURE_ENDPOINT", "https://doxacode-east-us-2.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-04-01-preview"),
      apiKey: required("AZURE_API_KEY"),
    },
    jina: process.env.JINA_API_KEY ? {
      apiKey: process.env.JINA_API_KEY,
      concurrency: parseInt(optional("JINA_CONCURRENCY", "5")),
    } : undefined,
    batchSize: parseInt(optional("BATCH_SIZE", "50")),
    staleMinutes: parseInt(optional("STALE_MINUTES", "60")),
    cron: {
      quickInterval: parseInt(optional("CRON_QUICK_MINUTES", "15")), // every 15 min by default
      fullInterval: parseInt(optional("CRON_FULL_MINUTES", "1440")), // every 24h by default
    },
  };
};

// =============================================================================
// Logging
// =============================================================================

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
        } catch (e) {
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
// Hash Cache (in-memory with persistence)
// =============================================================================

class HashCache {
  private cache = new Map<number, HashEntry>();
  private dirty = new Set<number>();
  private store: Datastore;

  constructor(private dataDir: string) {
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

    // Bulk upsert
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
// External APIs
// =============================================================================

const fetchJinaDescription = async (code: string, apiKey: string): Promise<string | null> => {
  try {
    const resp = await axios.get(
      `https://r.jina.ai/https://go-upc.com/search?q=${code}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      }
    );

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
// Sync Engine
// =============================================================================

const runSync = async (config: Config, mode: "full" | "quick"): Promise<void> => {
  const startTime = Date.now();
  const dataDir = `./data/${config.instanceName}`;

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  log.info(`Starting sync`, { mode, instance: config.instanceName });

  // Initialize hash cache
  const hashCache = new HashCache(dataDir);
  const existingHashes = await hashCache.load();
  log.info(`Loaded hash cache`, { entries: existingHashes });

  // Connect to source
  log.info(`Connecting to source...`, { host: config.source.host, port: config.source.port });
  const source = createSourceConnection(config);
  try {
    await new Promise<void>((resolve, reject) => {
      source.connect((err) => {
        if (err) {
          log.error(`Source connection failed`, {
            error: err.message,
            code: err.code,
            errno: err.errno
          });
          reject(err);
        } else {
          resolve();
        }
      });
    });
  } catch (e) {
    const err = e as any;
    throw new Error(`Failed to connect to source database: ${err.message || err.code || 'Unknown error'}`);
  }
  log.info(`Connected to source`, { host: config.source.host, db: config.source.database });

  // Count products
  const countResult = await new Promise<number>((resolve, reject) => {
    source.query(`SELECT COUNT(*) as total FROM ${config.source.table}`, (err, rows: any) => {
      err ? reject(err) : resolve(rows[0].total);
    });
  });
  log.info(`Total products in source`, { count: countResult });

  // Fetch all products
  const query = buildQuery(config);
  const allRows = await new Promise<any[]>((resolve, reject) => {
    source.query(query, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
  source.end();
  log.info(`Fetched all products`, { count: allRows.length });

  // Process products - determine status
  const staleMs = config.staleMinutes * 60 * 1000;
  const now = Date.now();
  const cols = config.columns;

  const products: ProductPayload[] = [];
  let skipped = 0;

  for (const row of allRows) {
    const productId = row[cols.id];
    const currentHash = createHash(Object.values(row).join("|"));
    const existing = hashCache.get(productId);

    // Quick mode: skip if not stale and hash matches
    if (mode === "quick" && existing) {
      const age = now - new Date(existing.updatedAt).getTime();
      if (age < staleMs && existing.hash === currentHash) {
        skipped++;
        continue;
      }
    }

    // Full mode: skip only if hash matches exactly
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
    new: products.filter(p => p.status === "new").length,
    changed: products.filter(p => p.status === "changed").length,
  });

  if (products.length === 0) {
    log.info(`No products to sync`);
    return;
  }

  // Jina lookup for NEW products only (parallel)
  const newProducts = products.filter((p) => p.status === "new");
  if (config.jina && newProducts.length > 0) {
    log.info(`Starting Jina lookups`, { count: newProducts.length, concurrency: config.jina.concurrency });

    const descriptions = await new ParallelPool(
      newProducts,
      config.jina.concurrency,
      async (p, i) => {
        if (i % 50 === 0) {
          log.progress(i, newProducts.length, "Jina lookups");
        }
        return fetchJinaDescription(p.product.code, config.jina!.apiKey);
      }
    ).run();

    for (let i = 0; i < newProducts.length; i++) {
      if (descriptions[i]) {
        newProducts[i].product.display_name = descriptions[i]!;
      }
    }

    log.info(`Jina lookups complete`, { found: descriptions.filter(Boolean).length });
  }

  // Generate embeddings in batches
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

  // Write to destination
  const dest = await createDestClient();
  log.info(`Connected to destination`);

  const withEmbedding = products.filter((p) => p.embedding);
  const withoutEmbedding = products.filter((p) => !p.embedding && p.status === "changed");

  // Upsert products with embeddings
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

      log.progress(Math.min(i + config.batchSize, withEmbedding.length), withEmbedding.length, "upserted with embedding");
    }
  }

  // Update products without new embeddings (data only)
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

      log.progress(Math.min(i + config.batchSize, withoutEmbedding.length), withoutEmbedding.length, "updated (data only)");
    }
  }

  await dest.end();

  // Update hash cache
  for (const p of products) {
    hashCache.set(p.product.id, p.hash);
  }
  const persisted = await hashCache.persist();
  log.info(`Persisted hashes`, { count: persisted });

  // Summary
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
// CLI
// =============================================================================

const printHelp = () => {
  console.log(`
Product Watcher - High Performance Sync

Usage:
  watcher --mode <full|quick>     Run once
  watcher --daemon                Run as cron daemon

Options:
  --mode <mode>    Sync mode: full or quick (default: full)
  --daemon         Run continuously with cron schedule
  --help           Show this help

Environment Variables:
  SOURCE_TYPE      mysql5, mysql8, or postgres
  SOURCE_HOST      Database host
  SOURCE_PORT      Database port (default: 3306)
  SOURCE_USER      Database user
  SOURCE_PASS      Database password
  SOURCE_DB        Database name
  SOURCE_TABLE     Table name

  WORKSPACE_ID     Workspace UUID
  AZURE_API_KEY    Azure OpenAI API key

  BATCH_SIZE           Products per batch (default: 50)
  STALE_MINUTES        Stale threshold for quick mode (default: 60)
  CRON_QUICK_MINUTES   Minutes between quick syncs (default: 15)
  CRON_FULL_MINUTES    Minutes between full syncs (default: 1440 = 24h)

  JINA_API_KEY     Optional: Enable Jina product lookup
  JINA_CONCURRENCY Parallel Jina requests (default: 5)

  COL_ID, COL_DESC, COL_CODE, COL_PRICE  Column mappings

Examples:
  watcher --mode quick
  watcher --daemon
`);
};

const main = async () => {
  const args = process.argv.slice(2);

  let mode: "full" | "quick" = "full";
  let daemon = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--mode":
        mode = args[++i] as "full" | "quick";
        break;
      case "--daemon":
        daemon = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  if (!process.env.SOURCE_HOST) {
    printHelp();
    process.exit(1);
  }

  try {
    const config = loadConfig();

    if (daemon) {
      log.info(`Starting daemon mode`, {
        quickEvery: `${config.cron.quickInterval}m`,
        fullEvery: `${config.cron.fullInterval}m`,
      });

      let lastQuickRun = 0;
      let lastFullRun = 0;

      // Run full sync on startup
      log.info(`Initial full sync...`);
      await runSync(config, "full");
      lastFullRun = Date.now();
      lastQuickRun = Date.now();

      // Cron loop
      while (true) {
        const now = Date.now();
        const quickIntervalMs = config.cron.quickInterval * 60 * 1000;
        const fullIntervalMs = config.cron.fullInterval * 60 * 1000;

        // Check if it's time for full sync
        if (config.cron.fullInterval > 0 && (now - lastFullRun) >= fullIntervalMs) {
          log.info(`Scheduled full sync`);
          await runSync(config, "full");
          lastFullRun = Date.now();
          lastQuickRun = Date.now(); // Reset quick timer after full
        }
        // Check if it's time for quick sync
        else if (config.cron.quickInterval > 0 && (now - lastQuickRun) >= quickIntervalMs) {
          log.info(`Scheduled quick sync`);
          await runSync(config, "quick");
          lastQuickRun = Date.now();
        }

        // Sleep for 1 minute before checking again
        await new Promise((r) => setTimeout(r, 60 * 1000));
      }
    } else {
      await runSync(config, mode);
    }
  } catch (e) {
    const err = e as Error;
    log.error(`Fatal error`, {
      error: err.message || String(e),
      stack: err.stack?.split('\n').slice(0, 3).join(' | ')
    });
    process.exit(1);
  }
};

main();
