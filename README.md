# Lucro Real — versão SaaS (Netlify)

Calculadora de precificação para e-commerce como produto de verdade:
cadastro, login, 7 dias de teste grátis, assinatura mensal recorrente via
Asaas (Pix, boleto ou cartão) e histórico salvo na nuvem por usuário. A
calculadora só é entregue depois que o servidor confirma login válido E
assinatura ativa (ou trial). Sem isso, ninguém vê o app — não tem link fixo
pra compartilhar.

Esta versão roda como **Netlify Functions** (serverless) com banco de dados
**Postgres** (em vez do SQLite em arquivo, que não sobrevive em ambiente
serverless — Netlify não tem disco persistente entre requisições).

## Deploy no Netlify — passo a passo

1. Crie uma conta em https://app.netlify.com (dá pra entrar direto com
   GitHub).
2. Suba esta pasta para um repositório no GitHub (ou use `netlify deploy`
   pela CLI, sem precisar de Git — ambos funcionam).
3. No painel da Netlify: **Add new site > Import an existing project**,
   escolha o repositório. As configurações de build (`netlify.toml`) já
   estão prontas no projeto — não precisa mexer em nada nessa tela.
4. **Antes do primeiro deploy**, ative o banco: no painel do site, vá em
   **Database** (ou **Integrations > Netlify DB**) e clique em **Enable**.
   Isso cria um Postgres (Neon) gratuito e já injeta a variável
   `NETLIFY_DATABASE_URL` automaticamente — você não precisa copiar nem
   colar nada.
5. Em **Site configuration > Environment variables**, adicione:
   - `JWT_SECRET` — gere um valor com
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `TRIAL_DAYS` — `7` (ou o número de dias de teste grátis que preferir)
   - `ASAAS_API_KEY`, `ASAAS_ENV`, `ASAAS_WEBHOOK_TOKEN`, `PLAN_VALUE_BRL` —
     veja a seção "Cobrança" abaixo (pode deixar em branco por enquanto e
     configurar depois — o app funciona em modo trial sem isso)
6. Clique em **Deploy site**. Em 1-2 minutos você tem uma URL do tipo
   `algumacoisa.netlify.app`. Depois, em **Domain management**, dá pra
   apontar um domínio próprio de graça.

## Como configurar a cobrança (Asaas)

1. Crie uma conta em https://www.asaas.com (comece no ambiente **sandbox**,
   que não cobra dinheiro real).
2. Em **Configurações > Integrações**, copie sua **Chave de API** → variável
   `ASAAS_API_KEY` na Netlify.
3. Em **Configurações > Webhooks**, cadastre uma assinatura apontando para
   `https://SEU-SITE.netlify.app/api/billing/webhook`, marque os eventos de
   pagamento (`PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`,
   `PAYMENT_DELETED`) e defina um **token de autenticação** → cole o mesmo
   valor em `ASAAS_WEBHOOK_TOKEN`.
4. Quando for cobrar de verdade, troque `ASAAS_ENV` para `production` e use
   a chave de API de produção.

Sem essas variáveis, o app continua funcionando em modo trial — só a tela
de "Assinar agora" fica desativada com um aviso.

## Rodando localmente (antes de subir pro Netlify)

Você vai precisar de um Postgres de teste — o mais rápido é criar um banco
grátis em https://neon.tech (leva 1 minuto, sem cartão) e usar a connection
string que eles dão.

```
npm install
cp .env.example .env
# edite o .env: cole a connection string do Neon em DATABASE_URL,
# e gere um JWT_SECRET forte (comando no .env.example)
npm start
```

Abra http://localhost:3000.

## O que mudou nesta versão em relação à versão "SQLite" (Railway/Render)

- `db/index.js` agora fala com Postgres (`pg`) em vez de SQLite — todas as
  consultas são assíncronas.
- `server.js` é o mesmo Express de sempre; `netlify/functions/server.js` só
  o embrulha com `serverless-http` para rodar como função.
- `netlify.toml` redireciona `/api/*`, `/app` e `/healthz` para a função;
  as páginas públicas (`/`, `/login.html`, `/register.html`,
  `/billing.html`) continuam sendo arquivos estáticos servidos direto pela
  CDN da Netlify — mais rápido, sem gastar execução de função.
- As regras de segurança são as mesmas de antes: senha com hash bcrypt,
  cookie de sessão `HttpOnly/Secure/SameSite=Strict`, toda consulta filtrada
  por `user_id` do dono da sessão (testado: um usuário não acessa nem apaga
  dado de outro), webhook do Asaas valida token e ignora eventos repetidos.

## Limitações conhecidas

- **Cold start**: a primeira requisição depois de um tempo sem uso pode
  demorar um pouco mais (função "acordando" + Postgres serverless
  "acordando"). Menos perceptível que o free tier do Render, mas existe.
- **Sem recuperação de senha nem verificação de e-mail** — mesmo ponto já
  registrado na versão anterior; precisa de um serviço de e-mail (ex:
  Resend) pra isso.
- **Timeout de função**: no plano gratuito da Netlify, cada requisição tem
  10 segundos pra responder. Nenhuma rota do app hoje chega perto disso, mas
  vale lembrar se algo for adicionado no futuro.

## Estrutura

```
server.js                    o app Express (rotas e regras de acesso)
netlify/functions/server.js   embrulha o server.js como Netlify Function
netlify.toml                  redirects e configuração de build
auth.js                       hash de senha, cookie de sessão, middlewares
db/index.js                   Postgres (schema + queries assíncronas)
billing/asaas.js              integração com a Asaas (assinatura + webhook)
public/                       páginas públicas (landing, login, cadastro, billing)
private/app.html              a calculadora — nunca servida sem passar pelo /app
```
