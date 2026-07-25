// ============================================================
// Lucro Real — integracao de cobranca recorrente via Asaas
// Documentacao: https://docs.asaas.com/
//
// Funciona em modo "nao configurado" ate que ASAAS_API_KEY seja definido:
// nesse caso as rotas de assinatura informam que o pagamento ainda nao
// esta ativo, mas o resto do produto (login, calculadora, trial) funciona.
// ============================================================
const crypto = require('crypto');

const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '';
const ASAAS_ENV = process.env.ASAAS_ENV || 'sandbox'; // 'sandbox' | 'production'
const BASE_URL = ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';
const PLAN_VALUE = Number(process.env.PLAN_VALUE_BRL || '49.90');
const PLAN_NAME = process.env.PLAN_NAME || 'Lucro Real — Assinatura mensal';

function isConfigured() {
  return Boolean(ASAAS_API_KEY);
}

async function asaasFetch(pathname, options = {}) {
  const res = await fetch(BASE_URL + pathname, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      access_token: ASAAS_API_KEY,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('Asaas API error: ' + (body.errors ? JSON.stringify(body.errors) : res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function createCustomer({ name, email, cpfCnpj }) {
  return asaasFetch('/customers', {
    method: 'POST',
    body: JSON.stringify({ name, email, cpfCnpj }),
  });
}

// Garante que um cliente ja existente no Asaas tenha o CPF/CNPJ preenchido
// (necessario para criar cobrancas; clientes criados antes dessa validacao
// podem ter ficado sem esse dado).
async function updateCustomerCpfCnpj(customerId, cpfCnpj) {
  return asaasFetch('/customers/' + encodeURIComponent(customerId), {
    method: 'PUT',
    body: JSON.stringify({ cpfCnpj }),
  });
}

function nextDueDateISO(daysFromNow = 1) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function createSubscription(customerId) {
  return asaasFetch('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'UNDEFINED', // deixa o cliente escolher Pix, boleto ou cartao na pagina do Asaas
      value: PLAN_VALUE,
      nextDueDate: nextDueDateISO(1),
      cycle: 'MONTHLY',
      description: PLAN_NAME,
    }),
  });
}

async function getCheckoutUrlForSubscription(subscriptionId) {
  const payments = await asaasFetch('/payments?subscription=' + encodeURIComponent(subscriptionId) + '&limit=1');
  const first = payments.data && payments.data[0];
  return first ? first.invoiceUrl : null;
}

// Confirma que o webhook recebido veio do Asaas comparando um token secreto
// que voce mesmo configura no painel do Asaas (Configuracoes > Webhooks > Token de autenticacao)
// com o header "asaas-access-token" enviado em cada chamada.
function verifyWebhookToken(req) {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN || '';
  const received = req.headers['asaas-access-token'] || '';
  if (!expected || !received) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(received));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Eventos que indicam assinatura paga/ativa
const ACTIVE_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
// Eventos que indicam que o acesso deve ser suspenso
const INACTIVE_EVENTS = new Set(['PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED', 'SUBSCRIPTION_DELETED']);

module.exports = {
  isConfigured, createCustomer, updateCustomerCpfCnpj, createSubscription, getCheckoutUrlForSubscription,
  verifyWebhookToken, ACTIVE_EVENTS, INACTIVE_EVENTS, PLAN_VALUE, PLAN_NAME,
};
