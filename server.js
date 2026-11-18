// Plataforma de checkout transparente (Cielo + Shopify) para vários lojistas.
// Sem dependências — Node 22.5+.
//
//   /                 site de apresentação + guia
//   /painel           painel do lojista (cadastro, integrações, pedidos)
//   /checkout?loja=   checkout de cada loja  (sem ?loja = demonstração)
//   /s/<loja>.js      script que o lojista instala no tema da Shopify

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { criarCielo, traduzirStatus } = require("./cielo");
const { criarShopify } = require("./shopify");
const { abrirBanco } = require("./db");
const { carregarChaveMestra, criarCofre, hashSenha, conferirSenha, novoToken, sha256 } = require("./cripto");

const env = process.env;
carregarEnv(path.join(__dirname, ".env"));
const PORTA = Number(env.PORT || 3000);
const DB_ARQUIVO = env.DB_ARQUIVO || path.join(__dirname, "dados", "checkout.db");
const db = abrirBanco(DB_ARQUIVO);
const cofre = criarCofre(carregarChaveMestra(path.dirname(DB_ARQUIVO)));
const CONVITE = env.CODIGO_CONVITE || ""; // se definido, é exigido no cadastro
// Admins da plataforma: e-mails separados por vírgula. A conta é criada normalmente no /painel.
const ADMINS = String(env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const ehAdmin = (u) => !!u && ADMINS.includes(String(u.email).toLowerCase());

// ======================= Configuração de cada loja =======================
const PADRAO = {
  marca: { cor: "#111827" },
  shopify: {
    loja: "", clientId: "", clientSecret: "", pularCarrinho: false, apenasPagos: true, enviarConfirmacao: true,
    embalagem: { nome: "Padrão", alturaCm: 11, larguraCm: 10, comprimentoCm: 16, pesoGramas: 300 }, conectadoEm: null,
  },
  cielo: { ambiente: "sandbox", merchantId: "", merchantKey: "", sopClientId: "", sopClientSecret: "", cartao: true, pix: true, testadoEm: null },
  checkout: { maxParcelas: 12, parcelasSemJuros: 1, jurosMes: 2.99, softDescriptor: "", freteFixo: 0, freteGratisAcima: 0, lojaUrl: "" },
};
const SEGREDOS = [["shopify", "clientSecret"], ["cielo", "merchantKey"], ["cielo", "sopClientSecret"]];

function mesclar(base, extra) {
  const r = { ...base };
  for (const [k, v] of Object.entries(extra || {})) r[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? mesclar(base[k], v) : v;
  return r;
}
const configCompleta = (loja) => mesclar(PADRAO, loja?.config);
const mascarar = (v) => (v ? "••••" + String(v).slice(-4) : "");

const cacheCtx = new Map();
function contexto(loja) {
  if (!loja) return CTX_DEMO;
  const c = cacheCtx.get(loja.id);
  if (c && c.versao === loja.atualizadoEm) return c;
  const cfg = configCompleta(loja);
  const seg = (s, k) => { try { return cofre.decifrar(cfg[s][k]); } catch { return null; } };
  const cie = { ...cfg.cielo, merchantKey: seg("cielo", "merchantKey"), sopClientSecret: seg("cielo", "sopClientSecret") };
  const sh = { ...cfg.shopify, clientSecret: seg("shopify", "clientSecret") };
  const simulacao = !(cie.merchantId && cie.merchantKey);
  const ctx = {
    versao: loja.atualizadoEm, id: loja.id, slug: loja.slug, nome: loja.nome, cfg, demo: false, simulacao,
    cielo: simulacao ? null : criarCielo({ ...cie, softDescriptor: cfg.checkout.softDescriptor }),
    shopify: sh.loja && sh.clientId && sh.clientSecret ? criarShopify({ loja: sh.loja, clientId: sh.clientId, clientSecret: sh.clientSecret }) : null,
    regras: regras(cfg.checkout),
  };
  cacheCtx.set(loja.id, ctx);
  return ctx;
}
function regras(c) {
  return {
    maxParcelas: Math.min(Math.max(Number(c.maxParcelas) || 1, 1), 12),
    parcelasSemJuros: Math.max(Number(c.parcelasSemJuros) || 1, 1),
    jurosMes: Math.max(Number(c.jurosMes) || 0, 0) / 100,
    freteFixo: Math.round((Number(c.freteFixo) || 0) * 100),
    freteGratisAcima: Math.round((Number(c.freteGratisAcima) || 0) * 100),
    softDescriptor: String(c.softDescriptor || "").slice(0, 13),
  };
}
const CTX_DEMO = {
  id: null, slug: null, nome: "Loja de demonstração", demo: true, simulacao: true, cielo: null, shopify: null,
  cfg: mesclar(PADRAO, { checkout: { freteFixo: 19.9, freteGratisAcima: 199 } }),
  regras: regras({ maxParcelas: 12, parcelasSemJuros: 1, jurosMes: 2.99, freteFixo: 19.9, freteGratisAcima: 199 }),
};
function ctxDaRequisicao(slug) {
  if (!slug) return CTX_DEMO;
  const loja = db.lojaPorSlug(String(slug));
  if (!loja) throw erro(404, "Loja não encontrada");
  if (loja.config?.admin?.bloqueada) throw erro(403, "Checkout indisponível no momento");
  return contexto(loja);
}
const ctxDoPedido = (p) => (p.lojaId ? contexto(db.lojaPorId(p.lojaId)) : CTX_DEMO);

// ======================= Carrinho e pedido =======================
const PRODUTOS = { "curso-pro": { nome: "Curso Pro de Marketing Digital", precoCentavos: 49700 } };
const CATALOGO_TESTE = {
  "111": { nome: "Camiseta Básica — M", precoCentavos: 8990 },
  "222": { nome: "Boné Aba Curva — Preto", precoCentavos: 6990 },
};

async function montarCarrinho(ctx, { itens, produtoId }) {
  let lista, fisico;
  if (itens) {
    const pares = String(itens).split(",").slice(0, 50).map((par) => {
      const [variantId, qtd] = par.split(":");
      if (!/^\d+$/.test(variantId || "")) throw erro(400, "Carrinho inválido");
      return { variantId, quantidade: Math.min(Math.max(parseInt(qtd, 10) || 1, 1), 99) };
    });
    if (!pares.length) throw erro(400, "Carrinho vazio");
    if (ctx.shopify) lista = await ctx.shopify.buscarItens(pares);
    else lista = pares.map((p) => {
      const f = CATALOGO_TESTE[p.variantId];
      if (!f) throw erro(400, ctx.demo ? "Produto de demonstração inexistente (use 111 ou 222)" : "Esta loja ainda não conectou a Shopify");
      return { ...p, gid: `gid://shopify/ProductVariant/${p.variantId}`, imagem: null, ...f };
    });
    fisico = true;
  } else {
    if (!ctx.demo) throw erro(400, "Carrinho vazio");
    const p = PRODUTOS[produtoId];
    if (!p) throw erro(404, "Produto não encontrado");
    lista = [{ variantId: produtoId, quantidade: 1, imagem: null, ...p }];
    fisico = false;
  }
  const subtotal = lista.reduce((s, i) => s + i.precoCentavos * i.quantidade, 0);
  const r = ctx.regras;
  const frete = !fisico || (r.freteGratisAcima && subtotal >= r.freteGratisAcima) ? 0 : r.freteFixo;
  return { itens: lista, subtotalCentavos: subtotal, freteCentavos: frete, totalCentavos: subtotal + frete, precisaEndereco: fisico, shopify: fisico && !ctx.demo };
}

function opcoesParcelamento(ctx, valor) {
  const r = ctx.regras, opcoes = [];
  for (let n = 1; n <= r.maxParcelas; n++) {
    let total = valor;
    if (n > r.parcelasSemJuros && r.jurosMes > 0) total = Math.round(((valor * r.jurosMes) / (1 - Math.pow(1 + r.jurosMes, -n))) * n);
    opcoes.push({ parcelas: n, totalCentavos: total, valorParcelaCentavos: Math.round(total / n), semJuros: total === valor });
  }
  return opcoes;
}

function validarCliente(c = {}) {
  if (!c.nome || c.nome.trim().split(/\s+/).length < 2) return "Informe nome e sobrenome";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email || "")) return "E-mail inválido";
  if (!cpfValido(String(c.cpf || "").replace(/\D/g, ""))) return "CPF inválido";
  return null;
}
function validarEndereco(e = {}) {
  if (!/^\d{8}$/.test(String(e.cep || "").replace(/\D/g, ""))) return "CEP inválido";
  for (const [k, n] of [["rua", "rua"], ["numero", "número"], ["bairro", "bairro"], ["cidade", "cidade"]]) if (!String(e[k] || "").trim()) return `Informe ${n}`;
  if (!/^[A-Z]{2}$/.test(String(e.uf || "").toUpperCase())) return "UF inválida";
  return null;
}
function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (len) => { let s = 0; for (let i = 0; i < len; i++) s += Number(cpf[i]) * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
}

async function prepararPedido(ctx, body, metodo) {
  if (metodo === "pix" && !ctx.cfg.cielo.pix) throw erro(400, "Pix indisponível nesta loja");
  if (metodo === "cartao" && !ctx.cfg.cielo.cartao) throw erro(400, "Cartão indisponível nesta loja");
  const carrinho = await montarCarrinho(ctx, body.carrinho || {});
  const msg = validarCliente(body.cliente) || (carrinho.precisaEndereco && validarEndereco(body.endereco));
  if (msg) throw erro(400, msg);
  const c = body.cliente, e = body.endereco || {};
  return {
    id: "PED-" + crypto.randomBytes(5).toString("hex").toUpperCase(), lojaId: ctx.id,
    metodo, parcelas: 1, status: "criado", paymentId: null, criadoEm: new Date().toISOString(),
    cliente: { nome: c.nome.trim(), email: c.email.trim(), cpf: String(c.cpf).replace(/\D/g, ""), telefone: c.telefone || "" },
    endereco: carrinho.precisaEndereco ? { ...e, cep: String(e.cep).replace(/\D/g, "").replace(/(\d{5})(\d{3})/, "$1-$2"), uf: String(e.uf).toUpperCase() } : null,
    itens: carrinho.itens, freteCentavos: carrinho.freteCentavos, totalCentavos: carrinho.totalCentavos, enviarParaShopify: carrinho.shopify,
  };
}

// Transição de status. "pago" é atômico no banco: o pedido vai uma vez só para a Shopify.
async function atualizarStatus(id, statusCielo, origem) {
  const novo = traduzirStatus(statusCielo);
  db.evento(id, "status", `${origem}: Cielo ${statusCielo} → ${novo}`);
  if (novo === "pago") { if (db.marcarPago(id)) { console.log(`✅ ${id} PAGO (${origem})`); await sincronizarShopify(id); } }
  else db.definirStatus(id, novo);
  return db.buscar(id);
}

// Pix com "criar apenas pedidos pagos" desligado: cria o pedido pendente na Shopify já na geração do QR Code
async function criarPendenteNaShopify(id) {
  const p = db.buscar(id), ctx = ctxDoPedido(p);
  if (!p.enviarParaShopify || !ctx.shopify || ctx.cfg.shopify.apenasPagos || p.shopifyId) return;
  try {
    const o = await ctx.shopify.criarPedido(p, { pago: false, enviarConfirmacao: false });
    db.shopifyOk(id, o.name, o.id, false);
  } catch (e) { db.shopifyErro(id, e.message); }
}

async function sincronizarShopify(id) {
  const p = db.buscar(id);
  if (!p || p.status !== "pago" || !p.enviarParaShopify || p.shopifyPago) return;
  const ctx = ctxDoPedido(p);
  if (!ctx.shopify) return db.evento(id, "shopify_pulado", "Shopify não conectada");
  try {
    if (p.shopifyId) { await ctx.shopify.marcarComoPago(p.shopifyId); db.shopifyOk(id, p.shopifyPedido, p.shopifyId, true); }
    else { const o = await ctx.shopify.criarPedido(p, { pago: true, enviarConfirmacao: ctx.cfg.shopify.enviarConfirmacao }); db.shopifyOk(id, o.name, o.id, true); }
  } catch (e) {
    db.shopifyErro(id, e.message); // pagamento aprovado: NÃO estorna; reprocessa depois
    console.error(`❌ Shopify falhou para ${id}: ${e.message}`);
  }
}

// ======================= Contas e sessões =======================
function lerCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function usuarioDaSessao(req) {
  const t = lerCookies(req).sessao;
  const s = t && db.sessao(sha256(t));
  return s ? db.usuarioPorId(s.usuario_id) : null;
}
function exigirLojista(req) {
  const u = usuarioDaSessao(req);
  if (!u) throw erro(401, "Faça login para continuar");
  const loja = db.lojaPorUsuario(u.id);
  if (!loja) throw erro(404, "Loja não encontrada");
  return { usuario: u, loja };
}
function exigirAdmin(req) {
  const u = usuarioDaSessao(req);
  if (!u) throw erro(401, "Faça login para continuar");
  if (!ehAdmin(u)) throw erro(403, "Acesso restrito ao administrador");
  return u;
}
function cookieSessao(req, token, maxAge) {
  const https = req.headers["x-forwarded-proto"] === "https";
  return `sessao=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}
const tentativas = new Map();
function limitar(req, chave, max = 10, janelaMs = 15 * 60e3) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const k = `${chave}:${ip}`, agora = Date.now(), t = tentativas.get(k);
  if (!t || t.reset < agora) return tentativas.set(k, { n: 1, reset: agora + janelaMs });
  if (++t.n > max) throw erro(429, "Muitas tentativas. Aguarde alguns minutos.");
}
function gerarSlug(nome) {
  const base = String(nome).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "loja";
  let slug = base;
  while (db.lojaPorSlug(slug)) slug = `${base}-${crypto.randomBytes(2).toString("hex")}`;
  return slug;
}

// Configuração vista pelo painel: segredos mascarados + status de cada integração
function configParaPainel(loja, req) {
  const ctx = contexto(loja), cfg = JSON.parse(JSON.stringify(ctx.cfg));
  for (const [s, k] of SEGREDOS) { let v = null; try { v = cofre.decifrar(cfg[s][k]); } catch {} cfg[s][k] = mascarar(v); cfg[s][k + "Salvo"] = !!v; }
  const base = urlBase(req);
  return {
    loja: { nome: loja.nome, slug: loja.slug }, config: cfg,
    status: {
      shopify: !!ctx.shopify, shopifyConectadoEm: cfg.shopify.conectadoEm,
      cielo: ctx.simulacao ? "simulacao" : cfg.cielo.ambiente, cieloTestadoEm: cfg.cielo.testadoEm,
      sop: !!(cfg.cielo.sopClientId && cfg.cielo.sopClientSecretSalvo),
    },
    urls: {
      checkout: `${base}/checkout?loja=${loja.slug}`,
      script: `${base}/s/${loja.slug}.js`,
      webhook: `${base}/webhook/cielo?loja=${loja.slug}`,
    },
  };
}
const urlBase = (req) => `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;

function aplicarSecao(loja, secao, dados = {}) {
  const atual = loja.config || {};
  const cfg = JSON.parse(JSON.stringify(atual));
  const txt = (v, max = 200) => String(v ?? "").trim().slice(0, max);
  const bool = (v) => v === true || v === "true";
  const num = (v, min, max) => Math.min(Math.max(Number(String(v).replace(",", ".")) || 0, min), max);
  const segredo = (s, k, v) => { v = txt(v, 500); if (v && !v.startsWith("••••")) cfg[s][k] = cofre.cifrar(v); };
  let nome = loja.nome;

  if (secao === "marca") {
    nome = txt(dados.nome, 60) || loja.nome;
    cfg.marca = { cor: /^#[0-9a-f]{6}$/i.test(dados.cor) ? dados.cor : "#111827" };
  } else if (secao === "shopify") {
    cfg.shopify = { ...(cfg.shopify || {}) };
    let dom = txt(dados.loja).toLowerCase();
    if (dom && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dom)) throw erro(400, "Use o domínio interno da loja, no formato minhaloja.myshopify.com (sem www., https://, / ou .br)");
    const antes = JSON.stringify([cfg.shopify.loja, cfg.shopify.clientId, cfg.shopify.clientSecret]);
    cfg.shopify.loja = dom;
    cfg.shopify.clientId = txt(dados.clientId);
    segredo("shopify", "clientSecret", dados.clientSecret);
    if (antes !== JSON.stringify([cfg.shopify.loja, cfg.shopify.clientId, cfg.shopify.clientSecret])) cfg.shopify.conectadoEm = null;
    for (const k of ["pularCarrinho", "apenasPagos", "enviarConfirmacao"]) if (k in dados) cfg.shopify[k] = bool(dados[k]);
    if (dados.embalagem) cfg.shopify.embalagem = {
      nome: txt(dados.embalagem.nome, 40) || "Padrão", alturaCm: num(dados.embalagem.alturaCm, 0, 300),
      larguraCm: num(dados.embalagem.larguraCm, 0, 300), comprimentoCm: num(dados.embalagem.comprimentoCm, 0, 300), pesoGramas: num(dados.embalagem.pesoGramas, 0, 100000),
    };
  } else if (secao === "cielo") {
    cfg.cielo = { ...(cfg.cielo || {}) };
    cfg.cielo.ambiente = dados.ambiente === "production" ? "production" : "sandbox";
    cfg.cielo.merchantId = txt(dados.merchantId);
    cfg.cielo.sopClientId = txt(dados.sopClientId);
    segredo("cielo", "merchantKey", dados.merchantKey);
    segredo("cielo", "sopClientSecret", dados.sopClientSecret);
    cfg.cielo.cartao = bool(dados.cartao); cfg.cielo.pix = bool(dados.pix);
    if (!cfg.cielo.cartao && !cfg.cielo.pix) throw erro(400, "Deixe pelo menos um meio de pagamento ativo");
    cfg.cielo.testadoEm = null;
  } else if (secao === "checkout") {
    cfg.checkout = {
      maxParcelas: num(dados.maxParcelas, 1, 12), parcelasSemJuros: num(dados.parcelasSemJuros, 1, 12), jurosMes: num(dados.jurosMes, 0, 15),
      softDescriptor: txt(dados.softDescriptor, 13).toUpperCase().replace(/[^A-Z0-9]/g, ""),
      freteFixo: num(dados.freteFixo, 0, 10000), freteGratisAcima: num(dados.freteGratisAcima, 0, 1000000),
      lojaUrl: /^https:\/\//.test(txt(dados.lojaUrl)) ? txt(dados.lojaUrl) : "",
    };
  } else throw erro(400, "Seção inválida");
  db.salvarLoja(loja.id, nome, cfg);
  return db.lojaPorId(loja.id);
}

// ======================= Rotas =======================
const rotas = {
  // ---------- checkout público ----------
  "GET /api/config": async (req, url) => {
    const ctx = ctxDaRequisicao(url.searchParams.get("loja"));
    return {
      demo: ctx.demo, modo: ctx.simulacao ? "simulacao" : "cielo", ambiente: ctx.cfg.cielo.ambiente,
      sopScript: ctx.simulacao ? null : ctx.cielo.sopScript, nome: ctx.nome, cor: ctx.cfg.marca.cor,
      lojaUrl: ctx.cfg.checkout.lojaUrl, cartao: ctx.cfg.cielo.cartao, pix: ctx.cfg.cielo.pix,
    };
  },
  "GET /api/carrinho": async (req, url) => {
    const ctx = ctxDaRequisicao(url.searchParams.get("loja"));
    const c = await montarCarrinho(ctx, { itens: url.searchParams.get("itens"), produtoId: url.searchParams.get("produto") });
    return { ...c, itens: c.itens.map(({ gid, ...i }) => i), parcelamento: opcoesParcelamento(ctx, c.totalCentavos) };
  },
  "POST /api/sop-token": async (req) => {
    const ctx = ctxDaRequisicao((await lerJson(req)).loja);
    if (ctx.simulacao) return { accessToken: "SIMULACAO" };
    if (!ctx.cfg.cielo.sopClientId) throw erro(400, "Loja sem Silent Order Post configurado");
    return { accessToken: await ctx.cielo.gerarAccessTokenSOP() };
  },
  "POST /api/pagar/cartao": async (req) => {
    const body = await lerJson(req), ctx = ctxDaRequisicao(body.loja);
    const pedido = await prepararPedido(ctx, body, "cartao");
    const opcao = opcoesParcelamento(ctx, pedido.totalCentavos).find((o) => o.parcelas === Number(body.parcelas));
    if (!opcao) throw erro(400, "Parcelamento inválido");
    if (!body.paymentToken) throw erro(400, "Token do cartão ausente");
    pedido.parcelas = opcao.parcelas; pedido.totalCentavos = opcao.totalCentavos;
    db.criar(pedido);
    if (ctx.simulacao) {
      db.definirPayment(pedido.id, "SIM-" + crypto.randomUUID());
      const a = await atualizarStatus(pedido.id, ["0", "1", "4"].includes(String(body.paymentToken).slice(-1)) ? 2 : 3, "cartao");
      return resposta(a, a.status === "pago" ? null : "Transação não autorizada (simulação)");
    }
    const venda = await ctx.cielo.venderCartao({
      pedidoId: pedido.id, cliente: pedido.cliente, valorCentavos: pedido.totalCentavos, parcelas: pedido.parcelas,
      paymentToken: body.paymentToken, bandeira: body.bandeira, softDescriptor: ctx.regras.softDescriptor || undefined,
    });
    db.definirPayment(pedido.id, venda.Payment.PaymentId);
    db.evento(pedido.id, "cielo_cartao", `ReturnCode ${venda.Payment.ReturnCode} ${venda.Payment.ReturnMessage || ""}`);
    const a = await atualizarStatus(pedido.id, venda.Payment.Status, "cartao");
    return resposta(a, a.status === "pago" ? null : venda.Payment.ReturnMessage || "Pagamento recusado");
  },
  "POST /api/pagar/pix": async (req) => {
    const body = await lerJson(req), ctx = ctxDaRequisicao(body.loja);
    const pedido = await prepararPedido(ctx, body, "pix");
    db.criar(pedido);
    let pix;
    if (ctx.simulacao) {
      db.definirPayment(pedido.id, "SIM-" + crypto.randomUUID());
      db.definirStatus(pedido.id, "pendente");
      pix = { qrCodeBase64: null, copiaECola: `00020126SIMULACAO${pedido.id}5204000053039865802BR6304ABCD` };
    } else {
      const venda = await ctx.cielo.venderPix({ pedidoId: pedido.id, cliente: pedido.cliente, valorCentavos: pedido.totalCentavos });
      db.definirPayment(pedido.id, venda.Payment.PaymentId);
      await atualizarStatus(pedido.id, venda.Payment.Status, "pix");
      pix = { qrCodeBase64: venda.Payment.QrCodeBase64Image, copiaECola: venda.Payment.QrCodeString };
    }
    criarPendenteNaShopify(pedido.id); // em segundo plano
    return { ...resposta(db.buscar(pedido.id)), pix };
  },
  "GET /api/pedido": async (req, url) => {
    let p = db.buscar(url.searchParams.get("id"));
    if (!p) throw erro(404, "Pedido não encontrado");
    const ctx = ctxDoPedido(p);
    if (!ctx.simulacao && p.status === "pendente" && p.paymentId) {
      const venda = await ctx.cielo.consultar(p.paymentId).catch(() => null);
      if (venda) p = await atualizarStatus(p.id, venda.Payment.Status, "consulta");
    }
    return resposta(p);
  },
  "POST /api/simular/pix-pago": async (req, url) => {
    const p = db.buscar(url.searchParams.get("id"));
    if (!p) throw erro(404, "Pedido não encontrado");
    if (!ctxDoPedido(p).simulacao) throw erro(403, "Disponível só no modo simulação");
    return resposta(await atualizarStatus(p.id, 2, "simulacao"));
  },
  // URL de notificação que o lojista cadastra na Cielo
  "POST /webhook/cielo": async (req) => {
    const { PaymentId, ChangeType } = await lerJson(req);
    const p = PaymentId && db.buscarPorPayment(PaymentId);
    if (p) {
      db.evento(p.id, "webhook", `ChangeType ${ChangeType}`);
      const ctx = ctxDoPedido(p);
      if (!ctx.simulacao) await atualizarStatus(p.id, (await ctx.cielo.consultar(PaymentId)).Payment.Status, "webhook");
    }
    return { ok: true };
  },
  "GET /saude": async () => ({ ok: true }),

  // ---------- conta do lojista ----------
  "POST /api/conta/cadastrar": async (req) => {
    limitar(req, "cadastro", 5);
    const b = await lerJson(req, true);
    if (CONVITE && b.convite !== CONVITE) throw erro(403, "Código de convite inválido");
    const email = String(b.email || "").trim().toLowerCase();
    if (!String(b.nome || "").trim()) throw erro(400, "Informe seu nome");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erro(400, "E-mail inválido");
    if (String(b.senha || "").length < 8) throw erro(400, "A senha precisa ter pelo menos 8 caracteres");
    if (!String(b.nomeLoja || "").trim()) throw erro(400, "Informe o nome da loja");
    if (db.usuarioPorEmail(email)) throw erro(409, "Já existe uma conta com este e-mail");
    const uid = "U-" + crypto.randomUUID();
    db.criarUsuario({ id: uid, email, nome: String(b.nome).trim().slice(0, 80), senhaHash: hashSenha(b.senha) });
    db.criarLoja({ id: "L-" + crypto.randomUUID(), usuarioId: uid, slug: gerarSlug(b.nomeLoja), nome: String(b.nomeLoja).trim().slice(0, 60), config: {} });
    const token = novoToken(); db.criarSessao(sha256(token), uid);
    return { ok: true, _cookie: cookieSessao(req, token, 30 * 86400) };
  },
  "POST /api/conta/entrar": async (req) => {
    limitar(req, "login");
    const b = await lerJson(req, true);
    const u = db.usuarioPorEmail(String(b.email || "").trim().toLowerCase());
    if (!u || !conferirSenha(String(b.senha || ""), u.senha_hash)) throw erro(401, "E-mail ou senha incorretos");
    const token = novoToken(); db.criarSessao(sha256(token), u.id);
    return { ok: true, _cookie: cookieSessao(req, token, 30 * 86400) };
  },
  "POST /api/conta/sair": async (req) => {
    const t = lerCookies(req).sessao; if (t) db.apagarSessao(sha256(t));
    return { ok: true, _cookie: cookieSessao(req, "", 0) };
  },
  "GET /api/conta/eu": async (req) => {
    const u = usuarioDaSessao(req);
    if (!u) return { logado: false, conviteObrigatorio: !!CONVITE };
    const l = db.lojaPorUsuario(u.id);
    return { logado: true, admin: ehAdmin(u), usuario: { nome: u.nome, email: u.email }, loja: l && { nome: l.nome, slug: l.slug, bloqueada: !!l.config?.admin?.bloqueada } };
  },

  // ---------- painel ----------
  "GET /api/painel/config": async (req) => configParaPainel(exigirLojista(req).loja, req),
  "PUT /api/painel/config": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    return configParaPainel(aplicarSecao(loja, b.secao, b.dados), req);
  },
  "POST /api/painel/shopify/testar": async (req) => {
    const { loja } = exigirLojista(req); await lerJson(req, true);
    const ctx = contexto(loja);
    if (!ctx.shopify) return { ok: false, motivo: "Preencha e salve a URL da loja, o Client ID e o Client Secret" };
    try {
      const s = await ctx.shopify.testar();
      const cfg = loja.config; cfg.shopify = { ...(cfg.shopify || {}), conectadoEm: new Date().toISOString() };
      db.salvarLoja(loja.id, loja.nome, cfg);
      return { ok: true, loja: s.name, dominio: s.myshopifyDomain, moeda: s.currencyCode };
    } catch (e) { return { ok: false, motivo: e.message.slice(0, 400) }; }
  },
  "POST /api/painel/shopify/desinstalar": async (req) => {
    const { loja } = exigirLojista(req); await lerJson(req, true);
    const cfg = loja.config;
    cfg.shopify = { ...PADRAO.shopify, embalagem: cfg.shopify?.embalagem || PADRAO.shopify.embalagem };
    db.salvarLoja(loja.id, loja.nome, cfg);
    return configParaPainel(db.lojaPorId(loja.id), req);
  },
  "GET /api/painel/shopify/produtos": async (req, url) => {
    const ctx = contexto(exigirLojista(req).loja);
    if (!ctx.shopify) throw erro(400, "Conecte a Shopify primeiro");
    return ctx.shopify.listarProdutos(String(url.searchParams.get("q") || "").slice(0, 60));
  },
  "POST /api/painel/cielo/testar": async (req) => {
    const { loja } = exigirLojista(req); await lerJson(req, true);
    const ctx = contexto(loja);
    if (ctx.simulacao) return { ok: false, motivo: "Preencha e salve o MerchantId e o MerchantKey" };
    const r = await ctx.cielo.testarCredenciais().catch((e) => ({ ok: false, motivo: e.message }));
    if (r.ok && ctx.cfg.cielo.sopClientId) {
      try { await ctx.cielo.gerarAccessTokenSOP(); r.sop = true; } catch (e) { r.sop = false; r.motivoSop = e.message.slice(0, 300); }
    }
    if (r.ok) { const cfg = loja.config; cfg.cielo = { ...(cfg.cielo || {}), testadoEm: new Date().toISOString() }; db.salvarLoja(loja.id, loja.nome, cfg); }
    return r;
  },
  // Dashboard: totais do período, série diária e receita acumulada (para o painel de conquistas)
  "GET /api/painel/resumo": async (req, url) => {
    const { loja } = exigirLojista(req);
    const dias = [7, 30, 90].includes(Number(url.searchParams.get("dias"))) ? Number(url.searchParams.get("dias")) : 30;
    const inicio = new Date(Date.now() - (dias - 1) * 864e5); inicio.setUTCHours(0, 0, 0, 0);
    const r = db.resumoDaLoja(loja.id, inicio.toISOString());
    const porDia = Object.fromEntries(db.serieDaLoja(loja.id, inicio.toISOString()).map((d) => [d.dia, d]));
    const serie = Array.from({ length: dias }, (_, i) => {
      const dia = new Date(inicio.getTime() + i * 864e5).toISOString().slice(0, 10);
      const d = porDia[dia] || {};
      return { dia, receita: d.receita || 0, pedidos: d.pedidos || 0, pagos: d.pagos || 0 };
    });
    return { dias, pedidos: r.n || 0, pagos: r.pagos || 0, receita: r.receita || 0,
      ticket: r.pagos ? Math.round(r.receita / r.pagos) : 0, serie, receitaTotal: db.receitaTotalDaLoja(loja.id) };
  },
  "GET /api/painel/pedidos": async (req) => {
    const { loja } = exigirLojista(req);
    return db.listarDaLoja(loja.id, 200).map((p) => ({
      id: p.id, status: p.status, metodo: p.metodo, parcelas: p.parcelas, totalCentavos: p.totalCentavos,
      cliente: p.cliente.nome, email: p.cliente.email, shopify: p.shopifyPedido, shopifyPago: p.shopifyPago, erroShopify: p.erroShopify, criadoEm: p.criadoEm,
    }));
  },
  "GET /api/painel/pedido": async (req, url) => {
    const { loja } = exigirLojista(req), p = db.buscar(url.searchParams.get("id"));
    if (!p || p.lojaId !== loja.id) throw erro(404, "Pedido não encontrado");
    return { ...p, eventos: db.eventos(p.id) };
  },
  "POST /api/painel/pedido/reprocessar": async (req, url) => {
    const { loja } = exigirLojista(req); await lerJson(req, true);
    const p = db.buscar(url.searchParams.get("id"));
    if (!p || p.lojaId !== loja.id) throw erro(404, "Pedido não encontrado");
    await sincronizarShopify(p.id);
    const a = db.buscar(p.id);
    return { shopify: a.shopifyPedido, shopifyPago: a.shopifyPago, erro: a.erroShopify };
  },
};

// ---------- admin da plataforma ----------
const desde30 = () => new Date(Date.now() - 30 * 864e5).toISOString();
Object.assign(rotas, {
  "GET /api/admin/resumo": async (req) => { exigirAdmin(req); return db.adminResumo(desde30()); },
  "GET /api/admin/lojas": async (req) => {
    exigirAdmin(req);
    return db.adminLojas(desde30()).map((l) => {
      const c = mesclar(PADRAO, l.config);
      return {
        id: l.id, slug: l.slug, nome: l.nome, dono: l.dono, email: l.email, criadoEm: l.criado_em, ultimoPedido: l.ultimo,
        pedidos30: l.pedidos, receita30: l.receita, bloqueada: !!c.admin?.bloqueada,
        shopify: c.shopify.loja ? (c.shopify.conectadoEm ? "conectada" : "não testada") : "não configurada", shopifyLoja: c.shopify.loja,
        cielo: c.cielo.merchantId && c.cielo.merchantKey ? c.cielo.ambiente : "simulacao",
      };
    });
  },
  "GET /api/admin/pedidos": async (req) => {
    exigirAdmin(req);
    return db.adminPedidos(200).map((p) => ({
      id: p.id, loja: p.lojaNome || "Demonstração", status: p.status, metodo: p.metodo, parcelas: p.parcelas, totalCentavos: p.totalCentavos,
      cliente: p.cliente.nome, shopify: p.shopifyPedido, shopifyPago: p.shopifyPago, erroShopify: p.erroShopify, criadoEm: p.criadoEm,
    }));
  },
  // Bloqueia/desbloqueia o checkout de uma loja (ex.: inadimplência ou fraude)
  "POST /api/admin/loja/bloquear": async (req) => {
    const u = exigirAdmin(req), b = await lerJson(req, true);
    const loja = db.lojaPorId(String(b.id || ""));
    if (!loja) throw erro(404, "Loja não encontrada");
    const cfg = loja.config || {};
    cfg.admin = { ...(cfg.admin || {}), bloqueada: !!b.bloquear, alteradoPor: u.email, alteradoEm: new Date().toISOString() };
    db.salvarLoja(loja.id, loja.nome, cfg);
    console.log(`🔒 ${u.email} ${b.bloquear ? "bloqueou" : "desbloqueou"} a loja ${loja.slug}`);
    return { ok: true, bloqueada: !!b.bloquear };
  },
});

function resposta(p, mensagem = null) {
  return { pedidoId: p.id, status: p.status, metodo: p.metodo, totalCentavos: p.totalCentavos, parcelas: p.parcelas, shopifyPedido: p.shopifyPago ? p.shopifyPedido : null, mensagem };
}

// Script do tema: carregado da plataforma, então mudanças no painel valem sem reinstalar
function scriptDaLoja(req, slug) {
  const loja = db.lojaPorSlug(slug);
  if (!loja) return "/* loja não encontrada */";
  const cfg = configCompleta(loja);
  const checkout = `${urlBase(req)}/checkout?loja=${encodeURIComponent(loja.slug)}`;
  return `/* Checkout transparente — ${loja.nome.replace(/\*\//g, "")} */
(function () {
  var CHECKOUT = ${JSON.stringify(checkout)}, PULAR_CARRINHO = ${cfg.shopify.pularCarrinho ? "true" : "false"};
  if (window.__checkoutExterno) return; window.__checkoutExterno = true;
  function irParaCheckout() {
    return fetch("/cart.js", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (cart) {
      if (!cart.items || !cart.items.length) return;
      var itens = cart.items.map(function (i) { return i.variant_id + ":" + i.quantity; }).join(",");
      location.href = CHECKOUT + "&itens=" + itens;
    });
  }
  document.addEventListener("submit", function (e) {
    var f = e.target, acao = (f.getAttribute && f.getAttribute("action")) || "";
    if (PULAR_CARRINHO && acao.indexOf("/cart/add") > -1) {
      e.preventDefault(); e.stopPropagation();
      fetch("/cart/add.js", { method: "POST", body: new FormData(f), credentials: "same-origin" }).then(irParaCheckout);
      return;
    }
    if (acao.indexOf("/cart") > -1 && e.submitter && e.submitter.name === "checkout") { e.preventDefault(); e.stopPropagation(); irParaCheckout(); }
  }, true);
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest('a[href*="/checkout"], button[name="checkout"], [data-checkout-externo]');
    if (el) { e.preventDefault(); e.stopPropagation(); irParaCheckout(); }
  }, true);
})();
`;
}

// ======================= Servidor HTTP =======================
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const m = url.pathname.match(/^\/s\/([a-z0-9-]+)\.js$/);
    if (m && req.method === "GET") {
      res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
      return res.end(scriptDaLoja(req, m[1]));
    }
    const rota = rotas[`${req.method} ${url.pathname}`];
    if (rota) {
      const r = await rota(req, url);
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (r && r._cookie) { headers["Set-Cookie"] = r._cookie; delete r._cookie; }
      res.writeHead(200, headers);
      return res.end(JSON.stringify(r));
    }
    if (req.method === "GET") return servirArquivo(res, url.pathname);
    enviar(res, 404, { erro: "Não encontrado" });
  } catch (e) {
    if (!e.status) console.error(e);
    enviar(res, e.status || 502, { erro: e.status ? e.message : "Erro ao processar. Tente novamente." });
  }
}).listen(PORTA, () => {
  console.log(`Site:    http://localhost:${PORTA}/`);
  console.log(`Painel:  http://localhost:${PORTA}/painel`);
  console.log(`Demo:    http://localhost:${PORTA}/checkout?itens=111:2,222:1`);
  console.log(`Banco:   ${DB_ARQUIVO}${CONVITE ? " · cadastro exige convite" : ""}`);
  console.log(ADMINS.length ? `Admins:  ${ADMINS.join(", ")}` : "⚠️  Nenhum admin: defina ADMIN_EMAILS com o seu e-mail");
});

// Conciliação a cada 5 min: Pix pendentes (caso o webhook se perca) e pedidos que não chegaram à Shopify
async function conciliar() {
  for (const p of db.pendentesDesde(new Date(Date.now() - 864e5).toISOString())) {
    const ctx = ctxDoPedido(p);
    if (ctx.simulacao) continue;
    const venda = await ctx.cielo.consultar(p.paymentId).catch(() => null);
    if (venda) await atualizarStatus(p.id, venda.Payment.Status, "conciliacao");
  }
  for (const p of db.comErroShopify()) await sincronizarShopify(p.id);
}
setInterval(() => conciliar().catch((e) => console.error("conciliação:", e.message)), 5 * 60e3).unref();
for (const sinal of ["SIGINT", "SIGTERM"]) process.on(sinal, () => { db.fechar(); process.exit(0); });

// Arquivos do site: procura em qualquer pasta (public/, raiz…)
function acharArquivos(dir, prof = 0, achados = {}) {
  if (prof > 4) return achados;
  let entradas = [];
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return achados; }
  for (const e of entradas) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dados") continue;
    const caminho = path.join(dir, e.name);
    if (e.isDirectory()) acharArquivos(caminho, prof + 1, achados);
    else if (/\.(html|css|svg|png|jpg|jpeg|webp|ico)$/i.test(e.name)) {
      // prefere o arquivo mais perto da raiz (assim um upload novo na raiz substitui cópias antigas em subpastas)
      const atual = achados[e.name];
      const nivel = (c) => path.relative(__dirname, c).split(path.sep).length;
      if (!atual || nivel(caminho) < nivel(atual)) achados[e.name] = caminho;
    }
  }
  return achados;
}
const ARQUIVOS = acharArquivos(__dirname);
console.log("Páginas encontradas:", Object.keys(ARQUIVOS).filter((n) => n.endsWith(".html")).join(", ") || "NENHUMA (suba index.html, painel.html e checkout.html)");

function servirArquivo(res, p) {
  const paginas = { "/": "index.html", "/checkout": "checkout.html", "/checkout/": "checkout.html", "/painel": "painel.html", "/painel/": "painel.html" };
  const nome = paginas[p] || path.basename(decodeURIComponent(p));
  const arquivo = ARQUIVOS[nome];
  if (!arquivo) return enviar(res, 404, { erro: "Não encontrado", ...(/\.html$/.test(nome) && { dica: `Suba o arquivo ${nome} para o GitHub` }) });
  fs.readFile(arquivo, (err, dados) => {
    if (err) return enviar(res, 404, { erro: "Não encontrado" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(arquivo).toLowerCase()] || "application/octet-stream", "X-Frame-Options": "SAMEORIGIN" });
    res.end(dados);
  });
}
function enviar(res, status, corpo) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(corpo)); }
// exigirJson: rotas do painel só aceitam JSON (bloqueia envio de formulário de outro site)
function lerJson(req, exigirJson = false) {
  if (exigirJson && !String(req.headers["content-type"] || "").includes("application/json")) return Promise.reject(erro(415, "Envie JSON"));
  return new Promise((resolve, reject) => {
    let corpo = "";
    req.on("data", (c) => { corpo += c; if (corpo.length > 1e5) req.destroy(); });
    req.on("end", () => { try { resolve(corpo ? JSON.parse(corpo) : {}); } catch { reject(erro(400, "JSON inválido")); } });
  });
}
function erro(status, message) { return Object.assign(new Error(message), { status }); }
function carregarEnv(arquivo) {
  if (!fs.existsSync(arquivo)) return;
  for (const linha of fs.readFileSync(arquivo, "utf8").split("\n")) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
