// ============================================================
// Lucro Real — autenticacao (e-mail + senha, sessao via cookie JWT)
// ============================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  throw new Error('JWT_SECRET ausente ou fraco. Defina uma variavel de ambiente JWT_SECRET com pelo menos 32 caracteres aleatorios.');
}
const COOKIE_NAME = 'lr_session';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}
function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}
function newId(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomUUID().replace(/-/g, '');
}

function issueSession(res, userId) {
  // jti (token id) rotaciona a cada login/cadastro, evitando reuso de sessao fixa
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: userId, jti }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  });
}
function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function readSessionUserId(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.sub || null;
  } catch (e) {
    return null;
  }
}

// Middleware: exige usuario autenticado, injeta req.userId
function requireAuth(req, res, next) {
  const userId = readSessionUserId(req);
  if (!userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not_authenticated' });
    return res.redirect('/login.html');
  }
  req.userId = userId;
  next();
}

// Middleware: exige assinatura ativa (ou trial valido). Deve vir depois de requireAuth.
// Assincrono porque a consulta ao Postgres e via rede.
function requireActiveSubscription(db) {
  return async function (req, res, next) {
    try {
      const user = await db.get('SELECT * FROM users WHERE id = $1', [req.userId]);
      if (!user) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not_authenticated' });
        return res.redirect('/login.html');
      }
      const trialActive = user.trial_ends_at && new Date(user.trial_ends_at) > new Date();
      const subActive = user.subscription_status === 'active';
      if (!subActive && !trialActive) {
        if (req.path.startsWith('/api/')) return res.status(402).json({ error: 'subscription_required' });
        return res.redirect('/billing.html');
      }
      req.user = user;
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = {
  hashPassword, verifyPassword, newId,
  issueSession, clearSession, readSessionUserId,
  requireAuth, requireActiveSubscription,
  COOKIE_NAME,
};
