// ============================================================
// Lucro Real — camada de banco de dados (Postgres, via Netlify DB / Neon)
//
// Netlify Functions nao tem disco persistente entre chamadas, entao o banco
// precisa ser externo. Netlify DB (powered by Neon) injeta a variavel
// NETLIFY_DATABASE_URL automaticamente quando voce ativa o recurso no
// painel; tambem aceitamos DATABASE_URL pra rodar em qualquer Postgres.
// ============================================================
const { Pool } = require('pg');

const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('Defina NETLIFY_DATABASE_URL (Netlify DB) ou DATABASE_URL (qualquer Postgres) nas variaveis de ambiente.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('sslmode=') ? undefined : { rejectUnauthorized: false },
  max: 3, // funcoes serverless: manter poucas conexoes por instancia
});

let readyPromise = null;
function ready() {
  if (!readyPromise) readyPromise = migrate();
  return readyPromise;
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nome TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      subscription_status TEXT NOT NULL DEFAULT 'inactive',
      trial_ends_at TIMESTAMPTZ,
      asaas_customer_id TEXT,
      asaas_subscription_id TEXT,
      subscription_updated_at TIMESTAMPTZ
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf_cnpj TEXT;

    CREATE TABLE IF NOT EXISTS historico (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      sku TEXT,
      categoria TEXT,
      preco_venda DOUBLE PRECISION NOT NULL DEFAULT 0,
      lucro_liquido DOUBLE PRECISION NOT NULL DEFAULT 0,
      margem_liquida DOUBLE PRECISION NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_historico_user ON historico(user_id);

    CREATE TABLE IF NOT EXISTS config (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      config_json TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(provider, event_id)
    );
  `);
}

// Pequena camada de compatibilidade para manter o resto do codigo legivel:
// todas as funcoes sao assincronas (Postgres via rede, diferente do SQLite local).
const db = {
  async query(sql, params) {
    await ready();
    return pool.query(sql, params);
  },
  // retorna a primeira linha ou undefined (equivalente ao .get() do SQLite)
  async get(sql, params) {
    const r = await this.query(sql, params);
    return r.rows[0];
  },
  // retorna todas as linhas (equivalente ao .all() do SQLite)
  async all(sql, params) {
    const r = await this.query(sql, params);
    return r.rows;
  },
  // executa um INSERT/UPDATE/DELETE, retorna { changes }
  async run(sql, params) {
    const r = await this.query(sql, params);
    return { changes: r.rowCount };
  },
};

module.exports = db;
