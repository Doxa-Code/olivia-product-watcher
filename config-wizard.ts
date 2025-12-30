#!/usr/bin/env bun
/**
 * Product Watcher - Configuration Wizard
 * Wizard interativo colorido para configurar novos clientes
 *
 * Usage: bun run config-wizard.ts <nome-cliente> <diretorio>
 */

import prompts from "prompts";
import mysql from "mysql";
import { Client } from "pg";
import fs from "node:fs";

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
  bgCyan: "\x1b[46m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
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
  dot: `${c.dim}●${c.reset}`,
};

// =============================================================================
// Banner
// =============================================================================

const printBanner = (clientName: string) => {
  console.log();
  console.log(`${c.cyan}${c.bold}`);
  console.log("  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║                                                          ║");
  console.log("  ║   ██████╗ ██████╗  ██████╗ ██████╗ ██╗   ██╗ ██████╗████████╗   ║");
  console.log("  ║   ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██║   ██║██╔════╝╚══██╔══╝   ║");
  console.log("  ║   ██████╔╝██████╔╝██║   ██║██║  ██║██║   ██║██║        ██║      ║");
  console.log("  ║   ██╔═══╝ ██╔══██╗██║   ██║██║  ██║██║   ██║██║        ██║      ║");
  console.log("  ║   ██║     ██║  ██║╚██████╔╝██████╔╝╚██████╔╝╚██████╗   ██║      ║");
  console.log("  ║   ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝  ╚═════╝   ╚═╝      ║");
  console.log("  ║                                                          ║");
  console.log("  ║            ██╗    ██╗ █████╗ ████████╗ ██████╗██╗  ██╗███████╗██████╗    ║");
  console.log("  ║            ██║    ██║██╔══██╗╚══██╔══╝██╔════╝██║  ██║██╔════╝██╔══██╗   ║");
  console.log("  ║            ██║ █╗ ██║███████║   ██║   ██║     ███████║█████╗  ██████╔╝   ║");
  console.log("  ║            ██║███╗██║██╔══██║   ██║   ██║     ██╔══██║██╔══╝  ██╔══██╗   ║");
  console.log("  ║            ╚███╔███╔╝██║  ██║   ██║   ╚██████╗██║  ██║███████╗██║  ██║   ║");
  console.log("  ║             ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝   ║");
  console.log("  ║                                                          ║");
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

// =============================================================================
// Destination Database (Hardcoded)
// =============================================================================

const DEST_CONFIG = {
  host: "doxacode.postgres.database.azure.com",
  port: 5432,
  user: "postgres",
  password: "doxa@2021",
  database: "postgres",
  ssl: { rejectUnauthorized: false },
};

interface Workspace {
  id: string;
  name: string;
}

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
    const result = await client.query(
      "SELECT id, name FROM public.workspaces ORDER BY name"
    );
    await client.end();
    return result.rows.map((r: { id: string; name: string }) => ({
      id: r.id,
      name: r.name,
    }));
  } catch (e) {
    try { await client.end(); } catch {}
    throw e;
  }
};

// =============================================================================
// Database Helpers
// =============================================================================

interface DbConfig {
  type: "mysql5" | "mysql8" | "postgres";
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

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
          resolve(rows.map((r) => r.Database).filter((d: string) => !["information_schema", "mysql", "performance_schema", "sys"].includes(d)));
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

// =============================================================================
// Wizard Steps
// =============================================================================

const runWizard = async (clientName: string, clientDir: string): Promise<boolean> => {
  printBanner(clientName);

  // Cancel handler
  prompts.override({});
  const onCancel = () => {
    console.log();
    console.log(`  ${style.warn("Configuração cancelada.")}`);
    console.log();
    process.exit(1);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: Database Type
  // ─────────────────────────────────────────────────────────────────────────
  printSection("1. Banco de Dados de Origem", "Onde estão seus produtos");

  const dbTypeRes = await prompts({
    type: "select",
    name: "type",
    message: "Tipo do banco de dados",
    choices: [
      { title: `${c.green}●${c.reset} MySQL 5.x`, description: "Versão antiga com autenticação insegura", value: "mysql5" },
      { title: `${c.blue}●${c.reset} MySQL 8.x`, description: "Versão moderna com caching_sha2", value: "mysql8" },
      { title: `${c.magenta}●${c.reset} PostgreSQL`, description: "Banco PostgreSQL", value: "postgres" },
    ],
    initial: 0,
  }, { onCancel });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: Connection Details
  // ─────────────────────────────────────────────────────────────────────────
  printSection("2. Conexão com o Banco", "Informe os dados de acesso");

  const defaultPort = dbTypeRes.type === "postgres" ? 5432 : 3306;

  const connRes = await prompts([
    {
      type: "text",
      name: "host",
      message: "Host",
      initial: "localhost",
    },
    {
      type: "number",
      name: "port",
      message: "Porta",
      initial: defaultPort,
    },
    {
      type: "text",
      name: "user",
      message: "Usuário",
      validate: (v) => v.length > 0 || "Obrigatório",
    },
    {
      type: "password",
      name: "password",
      message: "Senha",
    },
  ], { onCancel });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: Test Connection
  // ─────────────────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: Select Database
  // ─────────────────────────────────────────────────────────────────────────
  printSection("3. Selecione o Database", "Escolha ou digite o nome do database");

  process.stdout.write(`  ${style.info("▶")} Carregando databases...`);
  let databases: string[] = [];
  try {
    databases = await listDatabases(dbConfig);
    console.log(` ${style.check} (${databases.length} encontrados)`);
  } catch (e) {
    console.log(` ${style.cross}`);
    console.log(`  ${style.warn("Não foi possível listar databases. Digite manualmente.")}`);
  }
  console.log();

  const dbRes = await prompts({
    type: databases.length > 0 ? "autocomplete" : "text",
    name: "database",
    message: "Database",
    choices: databases.map((d) => ({ title: d, value: d })),
    suggest: (input, choices) =>
      choices.filter((c) => c.title.toLowerCase().includes(input.toLowerCase())),
    validate: (v) => v.length > 0 || "Obrigatório",
  }, { onCancel });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 5: Select Table
  // ─────────────────────────────────────────────────────────────────────────
  printSection("4. Tabela de Produtos", "Onde estão os dados dos produtos");

  process.stdout.write(`  ${style.info("▶")} Carregando tabelas...`);
  let tables: string[] = [];
  try {
    tables = await listTables({ ...dbConfig, database: dbRes.database });
    console.log(` ${style.check} (${tables.length} encontradas)`);
  } catch (e) {
    console.log(` ${style.cross}`);
    console.log(`  ${style.warn("Não foi possível listar tabelas. Digite manualmente.")}`);
  }
  console.log();

  const tableRes = await prompts({
    type: tables.length > 0 ? "autocomplete" : "text",
    name: "table",
    message: "Tabela de produtos",
    choices: tables.map((t) => ({ title: t, value: t })),
    suggest: (input, choices) =>
      choices.filter((c) => c.title.toLowerCase().includes(input.toLowerCase())),
    validate: (v) => v.length > 0 || "Obrigatório",
  }, { onCancel });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 6: Column Mapping
  // ─────────────────────────────────────────────────────────────────────────
  printSection("5. Mapeamento de Colunas", "Qual coluna corresponde a cada campo");

  process.stdout.write(`  ${style.info("▶")} Carregando colunas...`);
  let columns: string[] = [];
  try {
    columns = await listColumns({ ...dbConfig, database: dbRes.database, table: tableRes.table });
    console.log(` ${style.check} (${columns.length} encontradas)`);
  } catch (e) {
    console.log(` ${style.cross}`);
    console.log(`  ${style.warn("Não foi possível listar colunas. Digite manualmente.")}`);
  }
  console.log();

  const columnChoices = columns.map((col) => ({ title: col, value: col }));

  const makeColumnPrompt = (name: string, label: string, required: boolean) => ({
    type: columns.length > 0 ? "autocomplete" : "text",
    name,
    message: `${label}${required ? "" : " (opcional)"}`,
    choices: columnChoices,
    suggest: (input: string, choices: any[]) =>
      choices.filter((c) => c.title.toLowerCase().includes(input.toLowerCase())),
    validate: required ? ((v: string) => v.length > 0 || "Obrigatório") : undefined,
  });

  console.log(`  ${style.subtitle("Colunas obrigatórias:")}`);
  console.log();

  const requiredCols = await prompts([
    makeColumnPrompt("id", "ID do produto", true),
    makeColumnPrompt("desc", "Descrição", true),
    makeColumnPrompt("code", "Código de barras", true),
    makeColumnPrompt("price", "Preço", true),
  ], { onCancel });

  console.log();
  console.log(`  ${style.subtitle("Colunas opcionais:")}`);
  console.log();

  const optionalCols = await prompts([
    makeColumnPrompt("displayName", "Nome de exibição", false),
    makeColumnPrompt("manufactory", "Fabricante", false),
    makeColumnPrompt("stock", "Estoque", false),
    makeColumnPrompt("promoPrice", "Preço promoção", false),
    makeColumnPrompt("needPrescription", "Precisa receita (0/1)", false),
  ], { onCancel });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 7: Sync Settings
  // ─────────────────────────────────────────────────────────────────────────
  printSection("6. Configuração de Sync", "Workspace e chaves de API");

  // Fetch workspaces from destination database
  process.stdout.write(`  ${style.info("▶")} Carregando workspaces...`);
  let workspaces: Workspace[] = [];
  try {
    workspaces = await listWorkspaces();
    console.log(` ${style.check} (${workspaces.length} encontrados)`);
  } catch (e) {
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

    workspaceRes = await prompts({
      type: "autocomplete",
      name: "workspaceId",
      message: "Selecione o Workspace",
      choices: workspaceChoices,
      suggest: (input, choices) =>
        choices.filter((c) =>
          c.title.toLowerCase().includes(input.toLowerCase()) ||
          c.description?.toLowerCase().includes(input.toLowerCase())
        ),
    }, { onCancel });
  } else {
    workspaceRes = await prompts({
      type: "text",
      name: "workspaceId",
      message: "Workspace ID (UUID)",
      validate: (v) => {
        if (!v) return "Obrigatório";
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(v) || "Formato UUID inválido";
      },
    }, { onCancel });
  }

  const azureRes = await prompts([
    {
      type: "text",
      name: "azureEndpoint",
      message: "Azure OpenAI Endpoint",
      initial: "https://doxacode-east-us-2.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-04-01-preview",
      validate: (v) => v.length > 0 || "Obrigatório",
    },
    {
      type: "password",
      name: "azureApiKey",
      message: "Azure OpenAI API Key",
      validate: (v) => v.length > 0 || "Obrigatório",
    },
  ], { onCancel });

  const syncRes = { ...workspaceRes, ...azureRes };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 8: Jina (Optional)
  // ─────────────────────────────────────────────────────────────────────────
  printSection("7. Busca de Descrições (Jina)", "Opcional: melhora descrições de produtos");

  const jinaRes = await prompts([
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
  ], { onCancel });

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 9: Cron Schedule
  // ─────────────────────────────────────────────────────────────────────────
  printSection("8. Agendamento de Sync", "Intervalos para sincronização automática");

  const cronRes = await prompts([
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
  ], { onCancel });

  // ─────────────────────────────────────────────────────────────────────────
  // SAVE CONFIG
  // ─────────────────────────────────────────────────────────────────────────
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

  // Ensure directory exists
  if (!fs.existsSync(clientDir)) {
    fs.mkdirSync(clientDir, { recursive: true });
  }

  const configPath = `${clientDir}/config.env`;
  fs.writeFileSync(configPath, configContent);

  console.log(`  ${style.check} Configuração salva em ${style.highlight(configPath)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────────
  // SUCCESS
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`${c.green}${c.bold}`);
  console.log("  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║                                                          ║");
  console.log("  ║            ✓  CONFIGURAÇÃO CONCLUÍDA!                    ║");
  console.log("  ║                                                          ║");
  console.log("  ╚══════════════════════════════════════════════════════════╝");
  console.log(`${c.reset}`);
  console.log();
  console.log(`  ${style.subtitle("Próximos passos:")}`);
  console.log();
  console.log(`  ${style.arrow} watcher logs ${clientName}        ${style.dim("Ver logs")}`);
  console.log(`  ${style.arrow} watcher run ${clientName} quick   ${style.dim("Sync rápido")}`);
  console.log(`  ${style.arrow} watcher run ${clientName} full    ${style.dim("Sync completo")}`);
  console.log(`  ${style.arrow} watcher stop ${clientName}        ${style.dim("Parar container")}`);
  console.log();

  return true;
};

// =============================================================================
// Main
// =============================================================================

const main = async () => {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Uso: bun run config-wizard.ts <nome-cliente> <diretorio>");
    process.exit(1);
  }

  const clientName = args[0];
  const clientDir = args[1];

  try {
    const success = await runWizard(clientName, clientDir);
    process.exit(success ? 0 : 1);
  } catch (e) {
    console.error();
    console.error(`  ${style.error("Erro fatal:")} ${(e as Error).message}`);
    console.error();
    process.exit(1);
  }
};

main();
