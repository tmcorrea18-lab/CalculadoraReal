// ============================================================
// Lucro Real — ponto de entrada como Netlify Function
//
// Isso apenas envolve o app Express (definido em server.js, na raiz do
// projeto) com serverless-http, para rodar dentro de uma funcao serverless
// da Netlify. As rotas continuam identicas as usadas em qualquer outra
// hospedagem (Railway/Render/Fly) — nada muda no server.js por causa disso.
// ============================================================
const serverless = require('serverless-http');
const app = require('../../server');

exports.handler = serverless(app);
