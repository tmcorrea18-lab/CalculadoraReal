// ============================================================
// Lucro Real — servidor (Express), empacotado para Netlify Functions
// ============================================================
require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const db = require('./db');
const {
  hashPassword, verifyPassword, newId,
  issueSession, clearSession, readSessionUserId,
  requireAuth, requireActiveSubscription,
} = require('./auth');
const asaas = require('./billing/asaas');

const app = express();
const PORT = process.env.PORT || 3000;
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || '0'); // 0 = sem teste gratis, cliente paga antes de acessar

// Encapsula um handler async para que erros caiam no error handler do Express
// em vez de derrubar a funcao serverless com uma promise rejeitada sem tratamento.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// ------------------------------------------------------------
// Paginas publicas (landing, login, cadastro, billing) + assets
// No Netlify isso normalmente e servido direto como arquivo estatico
// (mais rapido); mantemos aqui tambem para funcionar em qualquer host.
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/register', ah(async (req, res) => {
  const { email, password, nome } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'E-mail invalido.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });

  const emailNorm = email.toLowerCase().trim();
  const existing = await db.get('SELECT id FROM users WHERE email = $1', [emailNorm]);
  if (existing) return res.status(409).json({ error: 'Ja existe uma conta com esse e-mail.' });

  const id = newId('u');
  // TRIAL_DAYS=0 (padrao): sem teste gratis, o acesso so libera apos o pagamento confirmar via webhook.
  const trialEndsAt = TRIAL_DAYS > 0 ? new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString() : null;
  await db.run(
    `INSERT INTO users (id, email, password_hash, nome, trial_ends_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, emailNorm, hashPassword(password), nome || null, trialEndsAt]
  );

  issueSession(res, id);
  res.status(201).json({ ok: true, trialEndsAt });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.get('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase().trim()]);
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  issueSession(res, user.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', ah(async (req, res) => {
  const userId = readSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'not_authenticated' });
  const user = await db.get('SELECT id, email, nome, subscription_status, trial_ends_at FROM users WHERE id = $1', [userId]);
  if (!user) return res.status(401).json({ error: 'not_authenticated' });
  const trialActive = Boolean(user.trial_ends_at && new Date(user.trial_ends_at) > new Date());
  res.json({ ...user, trialActive, active: user.subscription_status === 'active' || trialActive });
}));

// ------------------------------------------------------------
// APP protegido (a calculadora) — so serve o HTML se autenticado + assinatura/trial ok
// ------------------------------------------------------------
app.get('/app', requireAuth, requireActiveSubscription(db), (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'app.html'));
});

// ------------------------------------------------------------
// HISTORICO (persistido por usuario)
// ------------------------------------------------------------
app.get('/api/historico', requireAuth, requireActiveSubscription(db), ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM historico WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
  res.json(rows.map(r => ({ ...r, snapshot: JSON.parse(r.snapshot_json) })));
}));

app.post('/api/historico', requireAuth, requireActiveSubscription(db), ah(async (req, res) => {
  const { nome, sku, categoria, precoVenda, lucroLiquido, margemLiquida, snapshot } = req.body || {};
  if (!nome) return res.status(400).json({ error: 'Nome do produto e obrigatorio.' });
  const id = newId('h');
  await db.run(
    `INSERT INTO historico (id, user_id, nome, sku, categoria, preco_venda, lucro_liquido, margem_liquida, snapshot_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, req.userId, nome, sku || '', categoria || '', precoVenda || 0, lucroLiquido || 0, margemLiquida || 0, JSON.stringify(snapshot || {})]
  );
  res.status(201).json({ id });
}));

app.put('/api/historico/:id', requireAuth, requireActiveSubscription(db), ah(async (req, res) => {
  const row = await db.get('SELECT id FROM historico WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const { nome, sku, categoria, precoVenda, lucroLiquido, margemLiquida, snapshot } = req.body || {};
  await db.run(
    `UPDATE historico SET nome=$1, sku=$2, categoria=$3, preco_venda=$4, lucro_liquido=$5, margem_liquida=$6, snapshot_json=$7
     WHERE id=$8 AND user_id=$9`,
    [nome, sku || '', categoria || '', precoVenda || 0, lucroLiquido || 0, margemLiquida || 0, JSON.stringify(snapshot || {}), req.params.id, req.userId]
  );
  res.json({ ok: true });
}));

app.delete('/api/historico/:id', requireAuth, requireActiveSubscription(db), ah(async (req, res) => {
  await db.run('DELETE FROM historico WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------
// CONFIG (taxas padrao por canal, por usuario)
// ------------------------------------------------------------
const CONFIG_DEFAULTS = {
  siteproprio: { label: 'Site Próprio', comissao: 0, taxaFixa: 0, imposto: 6, gateway: 3.5 },
  whatsapp: { label: 'WhatsApp', comissao: 0, taxaFixa: 0, imposto: 6, gateway: 2 },
  mercadolivre: { label: 'Mercado Livre', comissao: 16, taxaFixa: 6, imposto: 10, gateway: 0 },
  shopee: { label: 'Shopee', comissao: 14, taxaFixa: 4, imposto: 10, gateway: 0 },
  amazon: { label: 'Amazon', comissao: 15, taxaFixa: 5, imposto: 10, gateway: 0 },
  magalu: { label: 'Magalu', comissao: 16, taxaFixa: 5, imposto: 10, gateway: 0 },
};

app.get('/api/config', requireAuth, requireActiveSubscription(db), ah(async (req, res) => {
  const row = await db.get('SELECT config_json FROM config WHERE user_id = $1', [req.userId]);
  const cfg = row ? JSON.parse(row.config_json) : CONFIG_DEFAULTS;
  res.json(cfg);
}));

app.put('/api/config', requireAuth, requireActiveSubscription(db), ah(async (req, res) => {
  const cfg = req.body || {};
  await db.run(
    `INSERT INTO config (user_id, config_json, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = now()`,
    [req.userId, JSON.stringify(cfg)]
  );
  res.json({ ok: true });
}));

// ------------------------------------------------------------
// BILLING (Asaas)
// ------------------------------------------------------------
app.get('/api/billing/status', requireAuth, ah(async (req, res) => {
  const user = await db.get('SELECT subscription_status, trial_ends_at, cpf_cnpj FROM users WHERE id = $1', [req.userId]);
  const trialActive = Boolean(user.trial_ends_at && new Date(user.trial_ends_at) > new Date());
  res.json({
    configured: asaas.isConfigured(),
    status: user.subscription_status,
    trialActive,
    trialEndsAt: user.trial_ends_at,
    planValue: asaas.PLAN_VALUE,
    hasCpfCnpj: Boolean(user.cpf_cnpj),
  });
}));

app.post('/api/billing/subscribe', requireAuth, ah(async (req, res) => {
  if (!asaas.isConfigured()) {
    return res.status(503).json({ error: 'A cobrança ainda não foi configurada pelo administrador. Fale com o suporte.' });
  }
  const cpfCnpjDigits = String((req.body && req.body.cpfCnpj) || '').replace(/\D/g, '');
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.userId]);
    const cpfCnpj = user.cpf_cnpj || cpfCnpjDigits;
    if (!cpfCnpj || (cpfCnpj.length !== 11 && cpfCnpj.length !== 14)) {
      return res.status(400).json({ error: 'Informe um CPF ou CNPJ válido para gerar a cobrança.', needsCpfCnpj: true });
    }
    if (!user.cpf_cnpj) {
      await db.run('UPDATE users SET cpf_cnpj = $1 WHERE id = $2', [cpfCnpj, user.id]);
    }
    let customerId = user.asaas_customer_id;
    if (!customerId) {
      const customer = await asaas.createCustomer({ name: user.nome || user.email, email: user.email, cpfCnpj });
      customerId = customer.id;
      await db.run('UPDATE users SET asaas_customer_id = $1 WHERE id = $2', [customerId, user.id]);
    }
    const subscription = await asaas.createSubscription(customerId);
    await db.run('UPDATE users SET asaas_subscription_id = $1 WHERE id = $2', [subscription.id, user.id]);
    const checkoutUrl = await asaas.getCheckoutUrlForSubscription(subscription.id);
    res.json({ checkoutUrl });
  } catch (e) {
    console.error('Erro ao criar assinatura Asaas:', e.message);
    res.status(502).json({ error: 'Não foi possível iniciar a cobrança agora. Tente novamente em instantes.' });
  }
}));

app.post('/api/billing/webhook', ah(async (req, res) => {
  if (!asaas.verifyWebhookToken(req)) return res.status(401).json({ error: 'invalid_token' });

  const event = req.body && req.body.event;
  const payment = req.body && req.body.payment;
  const eventId = (payment && payment.id ? payment.id : '') + ':' + event;

  // idempotencia: ignora eventos repetidos
  try {
    await db.run('INSERT INTO webhook_events (id, provider, event_id) VALUES ($1, $2, $3)', [crypto.randomUUID(), 'asaas', eventId]);
  } catch (e) {
    return res.json({ ok: true, duplicate: true }); // UNIQUE violation -> ja processado
  }

  if (payment && payment.subscription) {
    const user = await db.get('SELECT id FROM users WHERE asaas_subscription_id = $1', [payment.subscription]);
    if (user) {
      if (asaas.ACTIVE_EVENTS.has(event)) {
        await db.run(`UPDATE users SET subscription_status='active', subscription_updated_at=now() WHERE id=$1`, [user.id]);
      } else if (asaas.INACTIVE_EVENTS.has(event)) {
        await db.run(`UPDATE users SET subscription_status='inactive', subscription_updated_at=now() WHERE id=$1`, [user.id]);
      }
    }
  }
  res.json({ ok: true });
}));

// ------------------------------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

// erro generico (evita vazar stack trace pro cliente)
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error' });
});

// ------------------------------------------------------------
// Execucao: como servidor tradicional (Railway/Render/Fly/local) OU
// como Netlify Function (empacotado com serverless-http).
// ------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => console.log(`Lucro Real rodando na porta ${PORT}`));
}

module.exports = app;
