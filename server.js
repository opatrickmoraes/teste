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
const { criarAppmax, criarAppmaxApp, traduzirStatusAppmax } = require("./appmax");
const { criarPagarme } = require("./pagarme");
const { abrirBanco } = require("./db");
const { carregarChaveMestra, criarCofre, hashSenha, conferirSenha, novoToken, sha256 } = require("./cripto");

const env = process.env;
carregarEnv(path.join(__dirname, ".env"));
const PORTA = Number(env.PORT || 3000);
// Banco: precisa ficar num VOLUME, senão cada publicação apaga contas, sessões (todo mundo
// é deslogado) e a chave que protege as credenciais. Ordem: DB_ARQUIVO absoluto, o volume que o
// Railway informa (RAILWAY_VOLUME_MOUNT_PATH), /data, e por último a pasta local "dados".
const VOLUME = [env.RAILWAY_VOLUME_MOUNT_PATH, "/data"].find((d) => d && fs.existsSync(d)) || null;
const DB_ARQUIVO = env.DB_ARQUIVO && path.isAbsolute(env.DB_ARQUIVO) && (!VOLUME || env.DB_ARQUIVO.startsWith(VOLUME))
  ? env.DB_ARQUIVO
  : VOLUME ? path.join(VOLUME, "checkout.db") : path.join(__dirname, "dados", "checkout.db");
const NA_NUVEM = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
const PERSISTENTE = !!VOLUME && DB_ARQUIVO.startsWith(VOLUME) || !NA_NUVEM;
const db = abrirBanco(DB_ARQUIVO);
if (!db.lerPlataforma("instalado_em")) db.gravarPlataforma("instalado_em", new Date().toISOString());
const cofre = criarCofre(carregarChaveMestra(path.dirname(DB_ARQUIVO)));
const CONVITE = env.CODIGO_CONVITE || ""; // se definido, é exigido no cadastro
const APPS_LOGO = ["shopify", "cielo", "appmax", "pagarme"];
// App Appmax da plataforma (criado pelo dono no portal de desenvolvedores da Appmax)
const APPMAX = {
  ambiente: env.APPMAX_AMBIENTE === "production" ? "production" : "sandbox",
  appId: env.APPMAX_APP_ID || "", appIdNum: String(env.APPMAX_APP_ID_NUM || ""),
  clientId: env.APPMAX_CLIENT_ID || "", clientSecret: env.APPMAX_CLIENT_SECRET || "",
};
const appmaxApp = criarAppmaxApp(APPMAX);
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
  gateway: "cielo", // cielo | appmax | pagarme
  cielo: { ambiente: "sandbox", merchantId: "", merchantKey: "", sopClientId: "", sopClientSecret: "", cartao: true, pix: true, testadoEm: null },
  appmax: { clientId: "", clientSecret: "", externalId: "", conectadoEm: null, estado: "" },
  pagarme: { chavePublica: "", chaveSecreta: "", testadoEm: null },
  // Logística: regras de frete calculadas pelo CEP do cliente
  logistica: { gratisRegioes: [], customizados: [], planilha: [] },
  checkout: { maxParcelas: 12, parcelasSemJuros: 1, jurosMes: 2.99, softDescriptor: "", freteFixo: 0, freteGratisAcima: 0, lojaUrl: "" },
  cupons: [],
  depoimento: { ativo: false, nome: "", texto: "", estrelas: 5 },
  recuperacao: { mensagem: "Oi {nome}! Vi que você não concluiu sua compra na {loja}. Seu carrinho continua separado, é só finalizar por aqui: {link}" },
};
const SEGREDOS = [["shopify", "clientSecret"], ["cielo", "merchantKey"], ["cielo", "sopClientSecret"], ["appmax", "clientSecret"], ["pagarme", "chaveSecreta"]];

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
  const amxSecret = seg("appmax", "clientSecret");
  const pgmSecret = seg("pagarme", "chaveSecreta");
  const gateway = ["appmax", "pagarme"].includes(cfg.gateway) ? cfg.gateway : "cielo";
  const temCielo = !!(cie.merchantId && cie.merchantKey);
  const temAppmax = !!(cfg.appmax.clientId && amxSecret);
  const temPagarme = !!(cfg.pagarme.chavePublica && pgmSecret);
  const simulacao = !{ cielo: temCielo, appmax: temAppmax, pagarme: temPagarme }[gateway];
  const ctx = {
    versao: loja.atualizadoEm, id: loja.id, slug: loja.slug, nome: loja.nome, cfg, demo: false, simulacao, gateway, temCielo, temAppmax, temPagarme,
    gatewayNome: { cielo: "Cielo", appmax: "Appmax", pagarme: "Pagar.me" }[gateway],
    pagarme: gateway === "pagarme" && temPagarme ? criarPagarme({ chavePublica: cfg.pagarme.chavePublica, chaveSecreta: pgmSecret }) : null,
    cielo: gateway === "cielo" && temCielo ? criarCielo({ ...cie, softDescriptor: cfg.checkout.softDescriptor }) : null,
    appmax: gateway === "appmax" && temAppmax ? criarAppmax({ ambiente: APPMAX.ambiente, clientId: cfg.appmax.clientId, clientSecret: amxSecret }) : null,
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
  id: null, slug: null, nome: "Loja de demonstração", demo: true, simulacao: true, cielo: null, appmax: null, pagarme: null, shopify: null, gateway: "cielo", gatewayNome: "Cielo",
  cfg: mesclar(PADRAO, { checkout: { freteFixo: 19.9, freteGratisAcima: 199 }, cupons: [{ codigo: "BEMVINDO10", tipo: "percentual", valor: 10, minimoCentavos: 0, ativo: true }] }),
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

// ======================= Trilha de recompensas =======================
// Os níveis valem para toda a plataforma e são editados pelo admin.
const RECOMPENSAS_PADRAO = {
  niveis: [
    { metaCentavos: 10000000, nome: "O jogo começou", premio: "Placa comemorativa de R$ 100 mil" },
    { metaCentavos: 50000000, nome: "Em ritmo de escala", premio: "Placa comemorativa de R$ 500 mil" },
    { metaCentavos: 100000000, nome: "Clube do milhão", premio: "Placa comemorativa de R$ 1 milhão" },
    { metaCentavos: 500000000, nome: "Liderança", premio: "Placa comemorativa de R$ 5 milhões" },
    { metaCentavos: 1000000000, nome: "Lenda", premio: "Placa comemorativa de R$ 10 milhões" },
  ],
  regulamento: "1. Conta o faturamento aprovado pelo checkout da plataforma desde a criação da conta, descontados os reembolsos.\n2. Cada nível é liberado automaticamente quando o faturamento atinge a meta.\n3. Os prêmios são enviados pela equipe da plataforma em até 30 dias após a conquista.\n4. Pedidos cancelados, estornados ou com suspeita de fraude não contam para a trilha.",
};
const configRecompensas = () => db.lerPlataforma("recompensas", RECOMPENSAS_PADRAO);
function verificarConquistas(lojaId) {
  if (!lojaId) return;
  const fat = db.receitaTotalDaLoja(lojaId);
  configRecompensas().niveis.forEach((n, i) => {
    if (fat >= n.metaCentavos && db.registrarConquista(lojaId, i + 1, n.metaCentavos)) console.log(`🏆 Loja ${lojaId} atingiu o nível ${i + 1}`);
  });
}
function estadoRecompensas(lojaId) {
  verificarConquistas(lojaId);
  const cfg = configRecompensas(), fat = db.receitaTotalDaLoja(lojaId), conq = db.conquistasDaLoja(lojaId);
  const nivelAtual = conq.length ? Math.max(...conq.map((c) => c.nivel)) : 0;
  const prox = cfg.niveis[nivelAtual] || null;
  return {
    faturamento: fat, nivelAtual, total: cfg.niveis.length, regulamento: cfg.regulamento,
    proxima: prox && { nivel: nivelAtual + 1, metaCentavos: prox.metaCentavos, faltam: Math.max(prox.metaCentavos - fat, 0) },
    niveis: cfg.niveis.map((n, i) => ({ nivel: i + 1, ...n, conquista: conq.find((c) => c.nivel === i + 1) || null })),
  };
}

// ======================= Carrinho e pedido =======================
const PRODUTOS = { "curso-pro": { nome: "Curso Pro de Marketing Digital", precoCentavos: 49700 } };
const CATALOGO_TESTE = {
  "111": { nome: "Camiseta Básica — M", precoCentavos: 8990 },
  "222": { nome: "Boné Aba Curva — Preto", precoCentavos: 6990 },
};

// ---------------- Logística ----------------
// UF a partir do CEP (faixas dos Correios). O servidor não confia na UF enviada pelo navegador.
const FAIXAS_CEP = [
  ["SP", 1000, 19999], ["RJ", 20000, 28999], ["ES", 29000, 29999], ["MG", 30000, 39999], ["BA", 40000, 48999], ["SE", 49000, 49999],
  ["PE", 50000, 56999], ["AL", 57000, 57999], ["PB", 58000, 58999], ["RN", 59000, 59999], ["CE", 60000, 63999], ["PI", 64000, 64999],
  ["MA", 65000, 65999], ["PA", 66000, 68899], ["AP", 68900, 68999], ["AM", 69000, 69299], ["RR", 69300, 69399], ["AM", 69400, 69899],
  ["AC", 69900, 69999], ["DF", 70000, 72799], ["GO", 72800, 72999], ["DF", 73000, 73699], ["GO", 73700, 76799], ["RO", 76800, 76999],
  ["TO", 77000, 77999], ["MT", 78000, 78899], ["MS", 79000, 79999], ["PR", 80000, 87999], ["SC", 88000, 89999], ["RS", 90000, 99999],
];
const UFS = [...new Set(FAIXAS_CEP.map((f) => f[0]))].sort();
const limparCep = (c) => String(c || "").replace(/\D/g, "");
function ufDoCep(cep) {
  const n = Number(limparCep(cep).slice(0, 5));
  if (limparCep(cep).length !== 8) return null;
  return (FAIXAS_CEP.find(([, a, b]) => n >= a && n <= b) || [])[0] || null;
}
const prazoTxt = (d) => (d ? (/^\d+$/.test(String(d)) ? `até ${d} dia${Number(d) > 1 ? "s" : ""} úteis` : String(d)) : "");

/**
 * Opções de frete para o CEP. Ordem:
 *  1) fretes customizados que valem para a UF e para o valor do pedido;
 *  2) linhas da planilha cuja faixa de CEP inclui o CEP;
 *  3) se nada valer, o frete padrão (Checkout → frete fixo).
 * Depois, frete grátis por região (UF + valor mínimo) e o "grátis acima de" geral zeram a opção mais barata.
 */
function opcoesFrete(ctx, subtotal, cep) {
  const lg = ctx.cfg.logistica || {}, r = ctx.regras, uf = ufDoCep(cep), n = Number(limparCep(cep));
  const ops = [];
  for (const f of lg.customizados || []) {
    if (!f.ativo) continue;
    if (f.ufs?.length && (!uf || !f.ufs.includes(uf))) continue;
    if (f.minimoCentavos && subtotal < f.minimoCentavos) continue;
    if (f.maximoCentavos && subtotal > f.maximoCentavos) continue;
    ops.push({ id: "c:" + f.id, nome: f.nome, prazo: prazoTxt(f.prazo), valorCentavos: f.valorCentavos });
  }
  if (uf) for (const [i, l] of (lg.planilha || []).entries()) {
    if (n >= l.cepInicio && n <= l.cepFim && (!l.minimoCentavos || subtotal >= l.minimoCentavos))
      ops.push({ id: "p:" + i, nome: l.nome || "Entrega", prazo: prazoTxt(l.prazo), valorCentavos: l.valorCentavos });
  }
  if (!ops.length) ops.push({ id: "padrao", nome: "Entrega padrão", prazo: "", valorCentavos: r.freteFixo });
  ops.sort((a, b) => a.valorCentavos - b.valorCentavos);
  const regiao = uf && (lg.gratisRegioes || []).find((g) => g.ativo && g.ufs?.includes(uf) && subtotal >= (g.minimoCentavos || 0));
  if ((regiao || (r.freteGratisAcima && subtotal >= r.freteGratisAcima)) && ops[0].valorCentavos > 0) {
    ops[0] = { ...ops[0], valorCentavos: 0, gratis: true, motivo: regiao ? regiao.nome : "Frete grátis" };
  }
  return { uf, opcoes: ops };
}
// Aplica a opção escolhida (ou a mais barata) no carrinho
function aplicarFrete(ctx, c, cep, freteId) {
  if (!c.precisaEndereco) { c.freteCentavos = 0; c.frete = null; return c; }
  if (limparCep(cep).length !== 8) {
    // sem CEP ainda: mostra uma estimativa (o checkout recalcula ao digitar o CEP)
    // Sem regras de logística, o frete padrão já é o valor final; com regras, depende do CEP.
    const lg = ctx.cfg.logistica || {};
    const temRegras = [lg.customizados, lg.planilha, lg.gratisRegioes].some((l) => (l || []).some((x) => x.ativo !== false));
    if (temRegras) { c.freteCentavos = 0; c.frete = null; c.freteCalculado = false; }
    else { const o = opcoesFrete(ctx, c.subtotalCentavos, "").opcoes[0]; c.freteCentavos = o.valorCentavos; c.frete = null; c.freteCalculado = true; }
  } else {
    const { uf, opcoes } = opcoesFrete(ctx, c.subtotalCentavos, cep);
    const esc = opcoes.find((o) => o.id === freteId) || opcoes[0];
    c.freteCentavos = esc.valorCentavos; c.frete = esc; c.opcoesFrete = opcoes; c.ufFrete = uf; c.freteCalculado = true;
  }
  c.totalCentavos = c.subtotalCentavos + c.freteCentavos;
  return c;
}

async function montarCarrinhoBase(ctx, { itens, produtoId, link }) {
  let lista, fisico;
  if (link) {
    const l = db.linkPorId(String(link));
    if (!l || l.lojaId !== ctx.id) throw erro(404, "Link de pagamento não encontrado");
    if (!l.ativo) throw erro(410, "Este link de pagamento foi desativado");
    const r = ctx.regras, sub = l.valorCentavos;
    const frete = !l.pedirEndereco || (r.freteGratisAcima && sub >= r.freteGratisAcima) ? 0 : r.freteFixo;
    return {
      itens: [{ variantId: "link:" + l.id, quantidade: 1, imagem: null, nome: l.titulo, descricao: l.descricao, precoCentavos: sub }],
      subtotalCentavos: sub, freteCentavos: frete, totalCentavos: sub + frete, precisaEndereco: l.pedirEndereco, shopify: false, linkId: l.id,
    };
  }
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

// Carrinho final: base + cupom de desconto (o desconto vale sobre os produtos, não sobre o frete)
async function montarCarrinho(ctx, pedido = {}) {
  const c = aplicarFrete(ctx, await montarCarrinhoBase(ctx, pedido), pedido.cep, pedido.frete);
  c.descontoCentavos = 0; c.cupom = null;
  const codigo = String(pedido.cupom || "").trim().toUpperCase();
  if (codigo) {
    const cp = (ctx.cfg.cupons || []).find((x) => x.ativo && x.codigo === codigo);
    if (!cp) throw erro(400, "Cupom inválido ou expirado");
    if (cp.minimoCentavos && c.subtotalCentavos < cp.minimoCentavos) throw erro(400, `Este cupom vale para compras a partir de R$ ${(cp.minimoCentavos / 100).toFixed(2).replace(".", ",")}`);
    const d = cp.tipo === "percentual" ? Math.round((c.subtotalCentavos * cp.valor) / 100) : Math.round(cp.valor * 100);
    c.descontoCentavos = Math.min(d, c.subtotalCentavos - 100 > 0 ? c.subtotalCentavos - 100 : 0); // mínimo de R$ 1,00 a pagar
    c.cupom = { codigo: cp.codigo, tipo: cp.tipo, valor: cp.valor };
    c.totalCentavos = c.subtotalCentavos - c.descontoCentavos + c.freteCentavos;
  }
  return c;
}

// Na Appmax o parcelamento (e os juros) seguem a configuração da conta do lojista
async function parcelamentoDaLoja(ctx, valor) {
  if (ctx.gateway === "appmax" && ctx.appmax) {
    try {
      const { mapa } = await ctx.appmax.parcelas(valor, ctx.regras.maxParcelas);
      const ops = Object.keys(mapa).map(Number).filter((n) => n >= 1 && n <= ctx.regras.maxParcelas).sort((a, b) => a - b)
        .map((n) => ({ parcelas: n, totalCentavos: mapa[n], valorParcelaCentavos: Math.round(mapa[n] / n), semJuros: mapa[n] <= valor }));
      if (ops.length) return ops;
    } catch (e) { console.error("Appmax parcelas:", e.message); }
  }
  return opcoesParcelamento(ctx, valor);
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
  if (!documentoValido(String(c.cpf || "").replace(/\D/g, ""))) return "CPF ou CNPJ inválido";
  return null;
}
function validarEndereco(e = {}) {
  if (!/^\d{8}$/.test(String(e.cep || "").replace(/\D/g, ""))) return "CEP inválido";
  for (const [k, n] of [["rua", "rua"], ["numero", "número"], ["bairro", "bairro"], ["cidade", "cidade"]]) if (!String(e[k] || "").trim()) return `Informe ${n}`;
  if (!/^[A-Z]{2}$/.test(String(e.uf || "").toUpperCase())) return "UF inválida";
  return null;
}
function documentoValido(d) { return d.length === 14 ? cnpjValido(d) : cpfValido(d); }
function cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (len) => { const pesos = len === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const s = pesos.reduce((t, p, i) => t + Number(c[i]) * p, 0) % 11; return s < 2 ? 0 : 11 - s; };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}
function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (len) => { let s = 0; for (let i = 0; i < len; i++) s += Number(cpf[i]) * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
}

async function prepararPedido(ctx, body, metodo) {
  if (metodo === "pix" && !ctx.cfg.cielo.pix) throw erro(400, "Pix indisponível nesta loja");
  if (metodo === "cartao" && !ctx.cfg.cielo.cartao) throw erro(400, "Cartão indisponível nesta loja");
  const carrinho = await montarCarrinho(ctx, { ...(body.carrinho || {}), cep: body.endereco?.cep, frete: body.frete });
  const msg = validarCliente(body.cliente) || (carrinho.precisaEndereco && validarEndereco(body.endereco));
  if (msg) throw erro(400, msg);
  const c = body.cliente, e = body.endereco || {};
  return {
    id: "PED-" + crypto.randomBytes(5).toString("hex").toUpperCase(), lojaId: ctx.id,
    metodo, parcelas: 1, status: "criado", paymentId: null, criadoEm: new Date().toISOString(),
    cliente: { nome: c.nome.trim(), email: c.email.trim(), cpf: String(c.cpf).replace(/\D/g, ""), telefone: c.telefone || "" },
    endereco: carrinho.precisaEndereco ? { ...e, cep: String(e.cep).replace(/\D/g, "").replace(/(\d{5})(\d{3})/, "$1-$2"), uf: carrinho.ufFrete || String(e.uf).toUpperCase(),
      frete: carrinho.frete ? { nome: carrinho.frete.nome, prazo: carrinho.frete.prazo, gratis: !!carrinho.frete.gratis } : null } : null,
    itens: carrinho.itens, freteCentavos: carrinho.freteCentavos, totalCentavos: carrinho.totalCentavos, enviarParaShopify: carrinho.shopify,
    linkId: carrinho.linkId || null, sessao: String(body.sessao || "").slice(0, 64),
    descontoCentavos: carrinho.descontoCentavos || 0, cupom: carrinho.cupom?.codigo || null,
  };
}

// Transição de status. "pago" é atômico no banco: o pedido vai uma vez só para a Shopify.
async function atualizarStatus(id, statusCielo, origem) {
  return aplicarStatus(id, traduzirStatus(statusCielo), origem, `Cielo ${statusCielo}`);
}
async function aplicarStatus(id, novo, origem, bruto) {
  db.evento(id, "status", `${origem}: ${bruto} → ${novo}`);
  if (novo === "pago") { if (db.marcarPago(id)) { console.log(`✅ ${id} PAGO (${origem})`); db.fecharAbandono(id); verificarConquistas(db.buscar(id)?.lojaId); emailsDoPedido("pedido_aprovado", id); await sincronizarShopify(id); } }
  else db.definirStatus(id, novo);
  return db.buscar(id);
}

// Consulta o status no gateway do pedido e aplica (polling, webhook e conciliação)
async function consultarGateway(p, origem) {
  const ctx = ctxDoPedido(p);
  if (ctx.simulacao || !p.paymentId) return p;
  if (String(p.paymentId).startsWith("pgm:")) {
    if (!ctx.pagarme) return p;
    const r = await ctx.pagarme.consultar(p.paymentId.slice(4)).catch(() => null);
    return r ? aplicarStatus(p.id, r.status, origem, `Pagar.me ${r.bruto}`) : p;
  }
  if (String(p.paymentId).startsWith("amx:")) {
    if (!ctx.appmax) return p;
    const r = await ctx.appmax.consultar(p.paymentId.slice(4)).catch(() => null);
    return r ? aplicarStatus(p.id, traduzirStatusAppmax(r.status), origem, `Appmax ${r.status}`) : p;
  }
  if (!ctx.cielo) return p;
  const venda = await ctx.cielo.consultar(p.paymentId).catch(() => null);
  return venda ? atualizarStatus(p.id, venda.Payment.Status, origem) : p;
}
const ipDaRequisicao = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim().replace(/^::ffff:/, "");

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
  delete cfg.appmax.estado;
  const base = urlBase(req);
  return {
    loja: { nome: loja.nome, slug: loja.slug }, config: cfg,
    status: {
      shopify: !!ctx.shopify, shopifyConectadoEm: cfg.shopify.conectadoEm,
      cielo: ctx.temCielo ? cfg.cielo.ambiente : "simulacao", cieloTestadoEm: cfg.cielo.testadoEm,
      gateway: ctx.gateway, simulacao: ctx.simulacao,
      appmax: ctx.temAppmax, appmaxConectadoEm: cfg.appmax.conectadoEm, appmaxAmbiente: APPMAX.ambiente, appmaxPlataforma: appmaxApp.configurado,
      pagarme: ctx.temPagarme, pagarmeTestadoEm: cfg.pagarme.testadoEm, pagarmeTeste: /^pk_test_/.test(cfg.pagarme.chavePublica),
      sop: !!(cfg.cielo.sopClientId && cfg.cielo.sopClientSecretSalvo),
    },
    urls: {
      checkout: `${base}/checkout?loja=${loja.slug}`,
      script: `${base}/s/${loja.slug}.js`,
      webhook: `${base}/webhook/cielo?loja=${loja.slug}`,
      appmaxConectar: `${base}/appmax/conectar`,
      webhookPagarme: `${base}/webhook/pagarme?loja=${loja.slug}`,
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
  } else if (secao.startsWith("logistica_") || secao === "embalagens") {
    cfg.logistica = { gratisRegioes: [], customizados: [], planilha: [], ...(cfg.logistica || {}) };
    const centavos = (v) => Math.round(num(v, 0, 1000000) * 100);
    const ufs = (l) => [...new Set((Array.isArray(l) ? l : []).map((u) => String(u).toUpperCase()).filter((u) => UFS.includes(u)))];
    const id = (v) => /^[a-z0-9]{4,16}$/.test(v || "") ? v : crypto.randomBytes(4).toString("hex");
    const lista = Array.isArray(dados.lista) ? dados.lista.slice(0, 200) : [];
    if (secao === "logistica_regioes") {
      cfg.logistica.gratisRegioes = lista.map((g) => {
        const r = { id: id(g.id), nome: txt(g.nome, 60) || "Frete grátis", ufs: ufs(g.ufs), minimoCentavos: centavos(g.minimo), ativo: bool(g.ativo) };
        if (!r.ufs.length) throw erro(400, `Escolha pelo menos um estado em "${r.nome}"`);
        return r;
      });
    } else if (secao === "logistica_custom") {
      if (lista.length > 10) throw erro(400, "Você pode ter até 10 fretes customizados");
      cfg.logistica.customizados = lista.map((f) => {
        const r = { id: id(f.id), nome: txt(f.nome, 60), prazo: txt(f.prazo, 40), valorCentavos: centavos(f.valor), ufs: ufs(f.ufs),
          minimoCentavos: centavos(f.minimo), maximoCentavos: centavos(f.maximo), ativo: bool(f.ativo) };
        if (!r.nome) throw erro(400, "Dê um nome para cada frete (ex.: Sedex, Motoboy)");
        if (r.maximoCentavos && r.maximoCentavos < r.minimoCentavos) throw erro(400, `Em "${r.nome}", o valor máximo do pedido é menor que o mínimo`);
        return r;
      });
    } else if (secao === "logistica_planilha") {
      // linhas: cep_inicio;cep_fim;valor;prazo;nome[;pedido_minimo]
      const linhas = String(dados.csv || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (linhas.length > 5000) throw erro(400, "A planilha pode ter até 5.000 linhas");
      const out = [];
      linhas.forEach((l, i) => {
        const c = l.split(/[;\t]/).map((x) => x.trim().replace(/^"|"$/g, ""));
        if (i === 0 && /[a-z]/i.test(c[0])) return; // cabeçalho
        const ini = limparCep(c[0]).padEnd(8, "0"), fim = limparCep(c[1]).padEnd(8, "9");
        if (ini.length !== 8 || fim.length !== 8 || Number(fim) < Number(ini)) throw erro(400, `Linha ${i + 1}: faixa de CEP inválida (${c[0]} a ${c[1]})`);
        const v = Number(String(c[2] || "").replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
        if (!(v >= 0)) throw erro(400, `Linha ${i + 1}: valor do frete inválido (${c[2] || "vazio"})`);
        out.push({ cepInicio: Number(ini), cepFim: Number(fim), valorCentavos: Math.round(v * 100), prazo: txt(c[3], 40), nome: txt(c[4], 60) || "Entrega", minimoCentavos: centavos(c[5] || 0) });
      });
      if (linhas.length && !out.length) throw erro(400, "Nenhuma faixa de CEP encontrada. Confira o formato: cep_inicio;cep_fim;valor;prazo;nome");
      cfg.logistica.planilha = out;
      cfg.logistica.planilhaAtualizadaEm = out.length ? new Date().toISOString() : null;
    } else if (secao === "embalagens") {
      const ems = lista.slice(0, 30).map((e) => ({ id: id(e.id), nome: txt(e.nome, 40) || "Embalagem", alturaCm: num(e.alturaCm, 0, 300),
        larguraCm: num(e.larguraCm, 0, 300), comprimentoCm: num(e.comprimentoCm, 0, 300), pesoGramas: num(e.pesoGramas, 0, 100000), padrao: bool(e.padrao) }));
      if (!ems.length) throw erro(400, "Cadastre pelo menos uma embalagem");
      if (!ems.some((e) => e.padrao)) ems[0].padrao = true;
      ems.forEach((e, i) => { if (e.padrao && ems.findIndex((x) => x.padrao) !== i) e.padrao = false; });
      cfg.logistica.embalagens = ems;
      const p = ems.find((e) => e.padrao);
      cfg.shopify = { ...(cfg.shopify || {}), embalagem: { nome: p.nome, alturaCm: p.alturaCm, larguraCm: p.larguraCm, comprimentoCm: p.comprimentoCm, pesoGramas: p.pesoGramas } };
    }
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
  } else if (secao === "gateway") {
    cfg.gateway = ["appmax", "pagarme"].includes(dados.gateway) ? dados.gateway : "cielo";
  } else if (secao === "appmax") {
    // credenciais inseridas à mão (quando a instalação pelo botão não for possível)
    cfg.appmax = { ...(cfg.appmax || {}) };
    cfg.appmax.clientId = txt(dados.clientId);
    segredo("appmax", "clientSecret", dados.clientSecret);
    if (dados.externalId !== undefined) cfg.appmax.externalId = txt(dados.externalId, 60);
    if (cfg.appmax.clientId && !cfg.appmax.conectadoEm) cfg.appmax.conectadoEm = new Date().toISOString();
  } else if (secao === "pagarme") {
    cfg.pagarme = { ...(cfg.pagarme || {}) };
    const pk = txt(dados.chavePublica, 120);
    if (pk && !/^pk_/.test(pk)) throw erro(400, "A chave pública da Pagar.me começa com pk_");
    if (dados.chaveSecreta && !/^sk_/.test(String(dados.chaveSecreta).trim())) throw erro(400, "A chave secreta da Pagar.me começa com sk_");
    if (pk !== cfg.pagarme.chavePublica) cfg.pagarme.testadoEm = null;
    cfg.pagarme.chavePublica = pk;
    segredo("pagarme", "chaveSecreta", dados.chaveSecreta ? String(dados.chaveSecreta).trim() : dados.chaveSecreta);
    if (!cfg.pagarme.chavePublica && cfg.gateway === "pagarme") cfg.gateway = "cielo";
  } else if (secao === "appmax_desconectar") {
    cfg.appmax = { ...PADRAO.appmax };
    if (cfg.gateway === "appmax") cfg.gateway = "cielo";
  } else if (secao === "cupons") {
    const lista = Array.isArray(dados.cupons) ? dados.cupons.slice(0, 100) : [];
    const vistos = new Set();
    cfg.cupons = lista.map((c) => {
      const codigo = txt(c.codigo, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
      if (!codigo) throw erro(400, "Todo cupom precisa de um código");
      if (vistos.has(codigo)) throw erro(400, `Cupom repetido: ${codigo}`); vistos.add(codigo);
      const tipo = c.tipo === "fixo" ? "fixo" : "percentual";
      const valor = tipo === "percentual" ? num(c.valor, 0, 100) : num(c.valor, 0, 100000);
      if (!(valor > 0)) throw erro(400, `Informe o desconto do cupom ${codigo}`);
      return { codigo, tipo, valor, minimoCentavos: Math.round(num(c.minimo || 0, 0, 1000000) * 100), ativo: c.ativo !== false };
    });
  } else if (secao === "depoimento") {
    cfg.depoimento = { ativo: bool(dados.ativo), nome: txt(dados.nome, 60), texto: txt(dados.texto, 280), estrelas: Math.round(num(dados.estrelas || 5, 1, 5)) };
    if (cfg.depoimento.ativo && (!cfg.depoimento.nome || !cfg.depoimento.texto)) throw erro(400, "Preencha o nome e o texto do depoimento");
  } else if (secao === "recuperacao") {
    const m = txt(dados.mensagem, 600);
    if (!m.includes("{link}")) throw erro(400, "A mensagem precisa ter {link}, para o cliente voltar ao checkout");
    cfg.recuperacao = { mensagem: m };
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
      demo: ctx.demo, modo: ctx.simulacao ? "simulacao" : ctx.gateway, gateway: ctx.gateway, ambiente: ctx.cfg.cielo.ambiente,
      sopScript: ctx.cielo ? ctx.cielo.sopScript : null,
      appmaxScript: ctx.appmax ? ctx.appmax.script : null, pagarmeChave: ctx.pagarme ? ctx.pagarme.chavePublica : null, appmaxExternalId: ctx.appmax ? ctx.cfg.appmax.externalId : null,
      nome: ctx.nome, cor: ctx.cfg.marca.cor,
      lojaUrl: ctx.cfg.checkout.lojaUrl, cartao: ctx.cfg.cielo.cartao, pix: ctx.cfg.cielo.pix,
      temCupom: (ctx.cfg.cupons || []).some((c) => c.ativo) || ctx.demo,
      depoimento: ctx.cfg.depoimento?.ativo ? { nome: ctx.cfg.depoimento.nome, texto: ctx.cfg.depoimento.texto, estrelas: ctx.cfg.depoimento.estrelas } : null,
      parcelasMax: ctx.regras.maxParcelas, parcelasSemJuros: ctx.regras.parcelasSemJuros,
    };
  },
  "GET /api/carrinho": async (req, url) => {
    const ctx = ctxDaRequisicao(url.searchParams.get("loja"));
    const c = await montarCarrinho(ctx, { itens: url.searchParams.get("itens"), produtoId: url.searchParams.get("produto"), link: url.searchParams.get("link"), cupom: url.searchParams.get("cupom"), cep: url.searchParams.get("cep"), frete: url.searchParams.get("frete") });
    return { ...c, itens: c.itens.map(({ gid, ...i }) => i), parcelamento: await parcelamentoDaLoja(ctx, c.totalCentavos) };
  },
  "POST /api/sop-token": async (req) => {
    const ctx = ctxDaRequisicao((await lerJson(req)).loja);
    if (ctx.simulacao || ctx.gateway !== "cielo") return { accessToken: "SIMULACAO" };
    if (!ctx.cfg.cielo.sopClientId) throw erro(400, "Loja sem Silent Order Post configurado");
    return { accessToken: await ctx.cielo.gerarAccessTokenSOP() };
  },
  "POST /api/pagar/cartao": async (req) => {
    const body = await lerJson(req), ctx = ctxDaRequisicao(body.loja);
    const pedido = await prepararPedido(ctx, body, "cartao");
    const opcao = (await parcelamentoDaLoja(ctx, pedido.totalCentavos)).find((o) => o.parcelas === Number(body.parcelas));
    if (!opcao) throw erro(400, "Parcelamento inválido");
    if (!body.paymentToken) throw erro(400, "Token do cartão ausente");
    const baseCentavos = pedido.totalCentavos;
    pedido.parcelas = opcao.parcelas; pedido.totalCentavos = opcao.totalCentavos;
    db.criar(pedido); db.vincularAbandono(ctx.id, pedido.sessao, pedido.id, !!body.recuperacao);
    if (ctx.simulacao) {
      db.definirPayment(pedido.id, "SIM-" + crypto.randomUUID());
      const a = await atualizarStatus(pedido.id, ["0", "1", "4"].includes(String(body.paymentToken).slice(-1)) ? 2 : 3, "cartao");
      return resposta(a, a.status === "pago" ? null : "Transação não autorizada (simulação)");
    }
    if (ctx.gateway === "pagarme") {
      // Pagar.me: um pedido com o token do cartão gerado no navegador
      try {
        const r = await ctx.pagarme.pagarCartao(pedido, { token: body.paymentToken, parcelas: pedido.parcelas, totalCentavos: pedido.totalCentavos, softDescriptor: ctx.regras.softDescriptor, ip: body.ip || ipDaRequisicao(req) });
        db.definirPayment(pedido.id, "pgm:" + r.id);
        db.evento(pedido.id, "pagarme_cartao", `${r.id} · ${r.bruto}${r.motivo ? " · " + r.motivo : ""}`);
        const a = await aplicarStatus(pedido.id, r.status, "cartao", `Pagar.me ${r.bruto}`);
        return resposta(a, a.status === "pago" ? null : a.status === "pendente" ? "Pagamento em análise" : r.motivo || "Pagamento recusado. Confira os dados ou use outro cartão.");
      } catch (e) {
        db.evento(pedido.id, "pagarme_erro", e.message);
        const a = await aplicarStatus(pedido.id, "recusado", "cartao", "Pagar.me erro");
        return resposta(a, e.pagarmeStatus && e.pagarmeStatus < 500 ? "Pagamento recusado. Confira os dados ou use outro cartão." : "Não foi possível processar agora. Tente de novo em instantes.");
      }
    }
    if (ctx.gateway === "appmax") {
      // Appmax: cliente → pedido → pagamento com o token gerado no navegador
      const am = ctx.appmax;
      let orderId;
      try {
        const customerId = await am.criarCliente({ cliente: pedido.cliente, endereco: pedido.endereco, ip: body.ip || ipDaRequisicao(req), itens: pedido.itens });
        orderId = await am.criarPedido({ customerId, itens: pedido.itens, subtotalCentavos: baseCentavos - pedido.freteCentavos + pedido.descontoCentavos, freteCentavos: pedido.freteCentavos, descontoCentavos: pedido.descontoCentavos, fisico: !!pedido.endereco });
        db.definirPayment(pedido.id, "amx:" + orderId);
        const r = await am.pagarCartao({ orderId, customerId, token: body.paymentToken, documento: pedido.cliente.cpf, titular: body.titular || pedido.cliente.nome, parcelas: pedido.parcelas, softDescriptor: ctx.regras.softDescriptor || undefined });
        db.evento(pedido.id, "appmax_cartao", `pedido ${orderId} · ${r.status}`);
        const a = await aplicarStatus(pedido.id, traduzirStatusAppmax(r.status), "cartao", `Appmax ${r.status}`);
        return resposta(a, a.status === "pago" ? null : a.status === "pendente" ? "Pagamento em análise" : "Pagamento recusado. Confira os dados ou use outro cartão.");
      } catch (e) {
        db.evento(pedido.id, "appmax_erro", e.message);
        const a = await aplicarStatus(pedido.id, "recusado", "cartao", "Appmax erro");
        return resposta(a, e.appmaxStatus && e.appmaxStatus < 500 ? "Pagamento recusado. Confira os dados ou use outro cartão." : "Não foi possível processar agora. Tente de novo em instantes.");
      }
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
    db.criar(pedido); db.vincularAbandono(ctx.id, pedido.sessao, pedido.id, !!body.recuperacao);
    let pix;
    if (ctx.simulacao) {
      db.definirPayment(pedido.id, "SIM-" + crypto.randomUUID());
      db.definirStatus(pedido.id, "pendente");
      pix = { qrCodeBase64: null, copiaECola: `00020126SIMULACAO${pedido.id}5204000053039865802BR6304ABCD` };
    } else if (ctx.gateway === "pagarme") {
      const r = await ctx.pagarme.pagarPix(pedido, { totalCentavos: pedido.totalCentavos, ip: body.ip || ipDaRequisicao(req) });
      db.definirPayment(pedido.id, "pgm:" + r.id);
      db.definirStatus(pedido.id, "pendente");
      db.evento(pedido.id, "pagarme_pix", `${r.id} · expira ${r.expiraEm || "-"}`);
      pix = { qrCodeBase64: null, qrCodeUrl: r.qrCodeUrl, copiaECola: r.copiaECola, expiraEm: r.expiraEm };
    } else if (ctx.gateway === "appmax") {
      const am = ctx.appmax;
      const customerId = await am.criarCliente({ cliente: pedido.cliente, endereco: pedido.endereco, ip: body.ip || ipDaRequisicao(req), itens: pedido.itens });
      const orderId = await am.criarPedido({ customerId, itens: pedido.itens, subtotalCentavos: pedido.totalCentavos - pedido.freteCentavos + pedido.descontoCentavos, freteCentavos: pedido.freteCentavos, descontoCentavos: pedido.descontoCentavos, fisico: !!pedido.endereco });
      db.definirPayment(pedido.id, "amx:" + orderId);
      const r = await am.pagarPix({ orderId, documento: pedido.cliente.cpf });
      db.definirStatus(pedido.id, "pendente");
      db.evento(pedido.id, "appmax_pix", `pedido ${orderId} · expira ${r.expiraEm || "-"}`);
      pix = { qrCodeBase64: r.qrCodeBase64, copiaECola: r.copiaECola, expiraEm: r.expiraEm };
    } else {
      const venda = await ctx.cielo.venderPix({ pedidoId: pedido.id, cliente: pedido.cliente, valorCentavos: pedido.totalCentavos });
      db.definirPayment(pedido.id, venda.Payment.PaymentId);
      await atualizarStatus(pedido.id, venda.Payment.Status, "pix");
      pix = { qrCodeBase64: venda.Payment.QrCodeBase64Image, copiaECola: venda.Payment.QrCodeString };
    }
    criarPendenteNaShopify(pedido.id); // em segundo plano
    emailsDoPedido("pix_gerado", pedido.id, { pix });
    return { ...resposta(db.buscar(pedido.id)), pix };
  },
  "GET /api/pedido": async (req, url) => {
    let p = db.buscar(url.searchParams.get("id"));
    if (!p) throw erro(404, "Pedido não encontrado");
    if (p.status === "pendente") p = await consultarGateway(p, "consulta");
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
      if (!ctx.simulacao) await consultarGateway(p, "webhook");
    }
    return { ok: true };
  },
  // Webhook do app Appmax (configurado uma vez, no app da plataforma). A Appmax não assina os
  // webhooks, então o status é sempre confirmado consultando a API.
  "POST /webhook/appmax": async (req) => {
    const b = await lerJson(req);
    const orderId = b?.data?.order_id ?? b?.data?.id;
    const p = orderId != null && db.buscarPorPayment("amx:" + orderId);
    if (p) { db.evento(p.id, "webhook", `Appmax ${b.event || ""}`); await consultarGateway(p, "webhook"); }
    return { ok: true };
  },

  // Webhook que o lojista cadastra na Pagar.me (Configurações → Webhooks). O status é sempre
  // confirmado consultando a API com a chave da loja, então um aviso falso não marca nada como pago.
  "POST /webhook/pagarme": async (req, url) => {
    const b = await lerJson(req);
    const d = b?.data || {};
    const orderId = String(d.id || "").startsWith("or_") ? d.id : d.order?.id;
    let p = orderId && db.buscarPorPayment("pgm:" + orderId);
    if (!p && d.code) { const q = db.buscar(String(d.code)); if (q && String(q.paymentId || "").startsWith("pgm:")) p = q; }
    const loja = url.searchParams.get("loja");
    if (p && loja) { const l = db.lojaPorSlug(loja); if (!l || l.id !== p.lojaId) p = null; }
    if (p) { db.evento(p.id, "webhook", `Pagar.me ${b.type || ""}`); await consultarGateway(p, "webhook"); }
    return { ok: true };
  },

  // ---------- instalação do app Appmax na conta do lojista ----------
  "GET /appmax/conectar": async (req) => {
    let loja; try { ({ loja } = exigirLojista(req)); } catch { return { _redirect: "/painel" }; }
    if (!appmaxApp.configurado) return { _redirect: "/painel?appmax=sem-app#appmax" };
    const estado = crypto.randomBytes(16).toString("hex");
    const cfg = loja.config; cfg.appmax = { ...(cfg.appmax || {}), estado }; db.salvarLoja(loja.id, loja.nome, cfg);
    try {
      const destino = await appmaxApp.iniciarInstalacao({
        externalKey: loja.id, urlCallback: `${urlBase(req)}/appmax/retorno?loja=${encodeURIComponent(loja.slug)}&estado=${estado}`,
        dominio: (req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0],
      });
      return { _redirect: destino };
    } catch (e) { console.error("Appmax authorize:", e.message); return { _redirect: "/painel?appmax=erro#appmax" }; }
  },
  // URL de validação do app: a Appmax chama durante a instalação e espera { external_id }
  "POST /appmax/validar": async (req) => {
    const b = await lerJson(req);
    if (APPMAX.appIdNum && String(b.app_id) !== APPMAX.appIdNum) throw erro(403, "app_id inválido");
    const loja = db.lojaPorId(String(b.external_key || b.client_key || ""));
    if (!loja) throw erro(404, "Instalação desconhecida");
    const cfg = loja.config, externalId = crypto.randomUUID();
    cfg.appmax = { ...(cfg.appmax || {}), externalId };
    if (b.client_id && b.client_secret) { cfg.appmax.clientId = String(b.client_id); cfg.appmax.clientSecret = cofre.cifrar(String(b.client_secret)); }
    db.salvarLoja(loja.id, loja.nome, cfg);
    return { external_id: externalId, alias: loja.nome };
  },
  // Volta do painel da Appmax: troca o token pelas credenciais do lojista
  "GET /appmax/retorno": async (req, url) => {
    const loja = db.lojaPorSlug(String(url.searchParams.get("loja") || ""));
    const estado = url.searchParams.get("estado"), token = url.searchParams.get("token");
    if (!loja || !token || !estado || loja.config?.appmax?.estado !== estado) return { _redirect: "/painel?appmax=invalido#appmax" };
    try {
      const cred = await appmaxApp.gerarCredenciais(token);
      const atual = db.lojaPorId(loja.id), cfg = atual.config; // relê: a validação já gravou o external_id
      cfg.appmax = { ...(cfg.appmax || {}), clientId: cred.clientId, clientSecret: cofre.cifrar(cred.clientSecret), conectadoEm: new Date().toISOString(), estado: "" };
      if (!configCompleta(atual).cielo.merchantId) cfg.gateway = "appmax"; // sem Cielo: Appmax vira o gateway
      db.salvarLoja(loja.id, atual.nome, cfg);
      return { _redirect: "/painel?appmax=ok#appmax" };
    } catch (e) { console.error("Appmax generate:", e.message); return { _redirect: "/painel?appmax=erro#appmax" }; }
  },
  // Diagnóstico: se "bancoDesde" muda a cada publicação, o banco não está no volume
  // Logotipos dos apps (enviados pelo admin). Só imagem; SVG vai com CSP que bloqueia scripts.
  "GET /logos": async (req, url) => {
    const app = String(url.searchParams.get("app") || "");
    const d = APPS_LOGO.includes(app) && db.lerPlataforma("logo:" + app);
    if (!d) throw erro(404, "Sem logotipo");
    return { _arquivo: { tipo: d.tipo, dados: Buffer.from(d.base64, "base64") } };
  },
  "GET /api/admin/logos": async (req) => {
    exigirAdmin(req);
    return { apps: APPS_LOGO.map((a) => ({ app: a, tem: !!db.lerPlataforma("logo:" + a) })) };
  },
  "PUT /api/admin/logo": async (req) => {
    exigirAdmin(req);
    const b = await lerJson(req, true, 700000);
    if (!APPS_LOGO.includes(b.app)) throw erro(400, "App desconhecido");
    if (!b.dataUrl) { db.gravarPlataforma("logo:" + b.app, null); return { ok: true }; }
    const m = String(b.dataUrl).match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw erro(400, "Envie uma imagem PNG, JPG, WEBP ou SVG");
    if (m[2].length > 680000) throw erro(413, "Imagem grande demais (máx. 500 KB)");
    db.gravarPlataforma("logo:" + b.app, { tipo: m[1], base64: m[2] });
    return { ok: true };
  },
  "GET /saude": async () => ({ ok: true, armazenamento: PERSISTENTE ? "permanente" : "temporario", bancoDesde: db.lerPlataforma("instalado_em") }),

  // ---------- checkout abandonado (o checkout avisa quando o cliente preenche o contato) ----------
  "POST /api/abandono": async (req) => {
    limitar(req, "abandono", 60, 10 * 60e3);
    const b = await lerJson(req);
    if (!b.loja || !b.sessao) return { ok: true };
    const ctx = ctxDaRequisicao(b.loja);
    const c = b.cliente || {}, email = String(c.email || "").trim(), tel = String(c.telefone || "").replace(/\D/g, "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && tel.length < 10) return { ok: true };
    const carrinho = await montarCarrinho(ctx, b.carrinho || {}).catch(() => null);
    if (!carrinho) return { ok: true };
    const a = db.salvarAbandono({
      id: "AB-" + crypto.randomBytes(12).toString("base64url"), lojaId: ctx.id, sessao: String(b.sessao).slice(0, 64),
      cliente: { nome: String(c.nome || "").trim().slice(0, 80), email: email.slice(0, 120), telefone: tel.slice(0, 13) },
      carrinho: { ...(b.carrinho.itens ? { itens: String(b.carrinho.itens).slice(0, 500) } : {}), ...(b.carrinho.link ? { link: String(b.carrinho.link) } : {}),
        resumo: carrinho.itens.map((i) => `${i.quantidade}× ${i.nome}`).join(", ").slice(0, 300) },
      totalCentavos: carrinho.totalCentavos,
    });
    return { ok: true, id: a?.id };
  },
  // Link de recuperação: devolve o carrinho e o contato para preencher o checkout
  "GET /api/abandono": async (req, url) => {
    const a = db.abandonoPorId(String(url.searchParams.get("rec") || ""));
    if (!a) throw erro(404, "Link de recuperação inválido");
    return { loja: db.lojaPorId(a.lojaId).slug, carrinho: { itens: a.carrinho.itens, link: a.carrinho.link },
      cliente: { nome: a.cliente.nome, email: a.cliente.email, telefone: a.cliente.telefone }, sessao: a.sessao };
  },

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
    return { logado: true, admin: ehAdmin(u), armazenamentoTemporario: !PERSISTENTE, usuario: { nome: u.nome, email: u.email }, loja: l && { nome: l.nome, slug: l.slug, bloqueada: !!l.config?.admin?.bloqueada, motivoBloqueio: l.config?.admin?.motivo || null } };
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
  // Aba Produtos: catálogo da Shopify + vendas pelo checkout nos últimos 30 dias
  "GET /api/painel/produtos": async (req, url) => {
    const { loja } = exigirLojista(req), ctx = contexto(loja);
    const vendas = db.vendasPorVariante(loja.id, new Date(Date.now() - 30 * 864e5).toISOString());
    const base = `${urlBase(req)}/checkout?loja=${loja.slug}`;
    if (!ctx.shopify) return { conectada: false, produtos: [], vendas };
    let produtos;
    try { produtos = await ctx.shopify.listarProdutos(String(url.searchParams.get("q") || "").slice(0, 60)); }
    catch (e) { throw erro(502, "Não foi possível ler os produtos da Shopify: " + e.message.slice(0, 200)); }
    return {
      conectada: true,
      produtos: produtos.map((p) => ({
        ...p,
        vendidos30: p.variantes.reduce((s, v) => s + (vendas[v.id]?.quantidade || 0), 0),
        receita30: p.variantes.reduce((s, v) => s + (vendas[v.id]?.receita || 0), 0),
        variantes: p.variantes.map((v) => ({ ...v, vendidos30: vendas[v.id]?.quantidade || 0, receita30: vendas[v.id]?.receita || 0, link: `${base}&itens=${v.id}:1` })),
      })),
    };
  },
  "GET /api/painel/frete/simular": async (req, url) => {
    const { loja } = exigirLojista(req);
    const ctx = contexto(loja), cep = url.searchParams.get("cep");
    if (limparCep(cep).length !== 8) throw erro(400, "Digite um CEP com 8 números");
    const valor = Math.round(Number(String(url.searchParams.get("valor") || "0").replace(",", ".")) * 100);
    return opcoesFrete(ctx, valor, cep);
  },
  "POST /api/painel/pagarme/testar": async (req) => {
    const { loja } = exigirLojista(req); await lerJson(req, true);
    const cfg = configCompleta(loja); let sk = null; try { sk = cofre.decifrar(cfg.pagarme.chaveSecreta); } catch {}
    if (!cfg.pagarme.chavePublica || !sk) return { ok: false, motivo: "Preencha e salve as duas chaves primeiro" };
    const teste = (k) => (/_test_/.test(k) ? "teste" : "producao");
    if (teste(cfg.pagarme.chavePublica) !== teste(sk)) return { ok: false, motivo: "Uma chave é de teste e a outra de produção. Use as duas do mesmo ambiente." };
    try {
      await criarPagarme({ chavePublica: cfg.pagarme.chavePublica, chaveSecreta: sk }).testar();
      cfg.pagarme.testadoEm = new Date().toISOString(); db.salvarLoja(loja.id, loja.nome, cfg);
      return { ok: true, ambiente: teste(sk) };
    } catch (e) { return { ok: false, motivo: e.message.slice(0, 300) }; }
  },
  "POST /api/painel/appmax/testar": async (req) => {
    const { loja } = exigirLojista(req); await lerJson(req, true);
    const cfg = configCompleta(loja); let sec = null; try { sec = cofre.decifrar(cfg.appmax.clientSecret); } catch {}
    if (!cfg.appmax.clientId || !sec) return { ok: false, motivo: "Conecte a Appmax primeiro" };
    try { await criarAppmax({ ambiente: APPMAX.ambiente, clientId: cfg.appmax.clientId, clientSecret: sec }).testar(); return { ok: true, externalId: !!cfg.appmax.externalId }; }
    catch (e) { return { ok: false, motivo: e.message.slice(0, 300) }; }
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
      reembolsoCentavos: p.reembolsoCentavos,
    }));
  },
  // ---------- recompensas ----------
  "GET /api/painel/recompensas": async (req) => estadoRecompensas(exigirLojista(req).loja.id),

  // ---------- reembolsos ----------
  "POST /api/painel/pedido/reembolsar": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    const p = db.buscar(String(b.id || ""));
    if (!p || p.lojaId !== loja.id) throw erro(404, "Pedido não encontrado");
    if (p.status !== "pago") throw erro(400, "Só pedidos pagos podem ser reembolsados");
    const restante = p.totalCentavos - p.reembolsoCentavos;
    const valor = b.valorCentavos ? Math.round(Number(b.valorCentavos)) : restante;
    if (!(valor > 0) || valor > restante) throw erro(400, `Valor inválido. Disponível para reembolso: R$ ${(restante / 100).toFixed(2).replace(".", ",")}`);
    const ctx = contexto(loja);
    if (!ctx.simulacao && String(p.paymentId).startsWith("pgm:")) {
      if (!ctx.pagarme) throw erro(400, "Conecte a Pagar.me para reembolsar este pedido");
      try { await ctx.pagarme.estornar(p.paymentId.slice(4), valor === p.totalCentavos ? null : valor); }
      catch (e) { db.evento(p.id, "reembolso_erro", e.message); throw erro(502, "A Pagar.me recusou o reembolso: " + e.message.slice(0, 200)); }
      db.evento(p.id, "pagarme_estorno", `solicitado ${valor}`);
    } else if (!ctx.simulacao && String(p.paymentId).startsWith("amx:")) {
      if (!ctx.appmax) throw erro(400, "Conecte a Appmax para reembolsar este pedido");
      try { await ctx.appmax.estornar(p.paymentId.slice(4), { total: valor === restante && !p.reembolsoCentavos, valorCentavos: valor }); }
      catch (e) { db.evento(p.id, "reembolso_erro", e.message); throw erro(502, "A Appmax recusou o reembolso: " + e.message.slice(0, 200)); }
      db.evento(p.id, "appmax_estorno", `solicitado ${valor}`);
    } else if (!ctx.simulacao) {
      if (!ctx.cielo) throw erro(400, "Conecte a Cielo para reembolsar este pedido");
      let r;
      try { r = await ctx.cielo.estornar(p.paymentId, valor === p.totalCentavos ? null : valor); }
      catch (e) { db.evento(p.id, "reembolso_erro", e.message); throw erro(502, "A Cielo recusou o reembolso: " + e.message.slice(0, 200)); }
      db.evento(p.id, "cielo_estorno", `Status ${r.Status} ${r.ReturnCode || ""} ${r.ReturnMessage || ""}`);
    }
    db.registrarReembolso(p.id, valor);
    emailsDoPedido("reembolso", p.id, { valor, chave: (p.reembolsoCentavos || 0) + valor });
    if (p.shopifyPedido) db.evento(p.id, "aviso", `Registre o reembolso também no pedido ${p.shopifyPedido} da Shopify`);
    return { ok: true };
  },
  "GET /api/painel/reembolsos": async (req) => {
    const { loja } = exigirLojista(req);
    return db.reembolsadosDaLoja(loja.id).map((p) => ({ id: p.id, cliente: p.cliente.nome, email: p.cliente.email, metodo: p.metodo,
      totalCentavos: p.totalCentavos, reembolsoCentavos: p.reembolsoCentavos, reembolsadoEm: p.reembolsadoEm, status: p.status, shopify: p.shopifyPedido }));
  },

  // ---------- checkout abandonado / recuperação manual ----------
  "GET /api/painel/abandonos": async (req, url) => {
    const { loja } = exigirLojista(req);
    const dias = [7, 30, 90].includes(Number(url.searchParams.get("dias"))) ? Number(url.searchParams.get("dias")) : 30;
    const lista = db.abandonosDaLoja(loja.id, new Date(Date.now() - dias * 864e5).toISOString());
    const base = `${urlBase(req)}/checkout?loja=${loja.slug}&rec=`;
    const ab = lista.filter((a) => a.status === "aberto"), rec = lista.filter((a) => a.status === "recuperado");
    return {
      mensagem: configCompleta(loja).recuperacao.mensagem, nomeLoja: loja.nome,
      itens: lista.map(({ sessao, ...a }) => ({ ...a, link: base + a.id })),
      resumo: { total: lista.length, abertos: ab.length, recuperados: rec.length,
        valorAberto: ab.reduce((s, a) => s + a.totalCentavos, 0), valorRecuperado: rec.reduce((s, a) => s + a.totalCentavos, 0) },
    };
  },
  "POST /api/painel/abandono/contatado": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    db.marcarContatado(String(b.id || ""), loja.id, !!b.contatado);
    return { ok: true };
  },

  // ---------- links de pagamento ----------
  "GET /api/painel/links": async (req) => {
    const { loja } = exigirLojista(req), base = `${urlBase(req)}/checkout?loja=${loja.slug}&link=`;
    return db.linksDaLoja(loja.id).map((l) => ({ ...l, url: base + l.id }));
  },
  "POST /api/painel/links": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    const titulo = String(b.titulo || "").trim().slice(0, 80);
    const valor = Math.round(Number(String(b.valor || "").replace(/\./g, "").replace(",", ".")) * 100);
    if (!titulo) throw erro(400, "Dê um nome para o link");
    if (!(valor >= 100)) throw erro(400, "O valor mínimo é R$ 1,00");
    if (valor > 10000000) throw erro(400, "Valor máximo: R$ 100.000,00");
    const id = crypto.randomBytes(5).toString("hex");
    db.criarLink({ id, lojaId: loja.id, titulo, descricao: String(b.descricao || "").trim().slice(0, 300), valorCentavos: valor, pedirEndereco: !!b.pedirEndereco });
    return { ok: true, id };
  },
  "POST /api/painel/links/ativo": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    db.ativarLink(String(b.id || ""), loja.id, !!b.ativo);
    return { ok: true };
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
        pedidos30: l.pedidos, receita30: l.receita, bloqueada: !!c.admin?.bloqueada, motivoBloqueio: c.admin?.motivo || null, plano: c.plano?.id || planoPadrao().id,
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
  "GET /api/admin/recompensas": async (req) => { exigirAdmin(req); return { config: configRecompensas(), conquistas: db.todasConquistas() }; },
  "PUT /api/admin/recompensas": async (req) => {
    exigirAdmin(req);
    const b = await lerJson(req, true);
    const niveis = (Array.isArray(b.niveis) ? b.niveis : []).slice(0, 10).map((n, i) => {
      const meta = Math.round(Number(String(n.meta).replace(/\./g, "").replace(",", ".")) * 100);
      if (!(meta > 0)) throw erro(400, `Informe a meta do nível ${i + 1}`);
      return { metaCentavos: meta, nome: String(n.nome || "").trim().slice(0, 40), premio: String(n.premio || "").trim().slice(0, 120) };
    });
    if (!niveis.length) throw erro(400, "Cadastre pelo menos um nível");
    for (let i = 1; i < niveis.length; i++) if (niveis[i].metaCentavos <= niveis[i - 1].metaCentavos) throw erro(400, "As metas precisam ser crescentes");
    db.gravarPlataforma("recompensas", { niveis, regulamento: String(b.regulamento || "").slice(0, 4000) });
    return { ok: true };
  },
  "POST /api/admin/conquista/entregue": async (req) => {
    exigirAdmin(req); const b = await lerJson(req, true);
    db.marcarEntregue(String(b.lojaId || ""), Number(b.nivel), !!b.entregue);
    return { ok: true };
  },
  // Bloqueia/desbloqueia o checkout de uma loja (ex.: inadimplência ou fraude)
  "POST /api/admin/loja/bloquear": async (req) => {
    const u = exigirAdmin(req), b = await lerJson(req, true);
    const loja = db.lojaPorId(String(b.id || ""));
    if (!loja) throw erro(404, "Loja não encontrada");
    const cfg = loja.config || {};
    cfg.admin = { ...(cfg.admin || {}), bloqueada: !!b.bloquear, motivo: b.bloquear ? "admin" : null, alteradoPor: u.email, alteradoEm: new Date().toISOString(),
      // desbloqueio manual: a cobrança não volta a bloquear por 7 dias
      liberadoManualEm: b.bloquear ? null : new Date().toISOString() };
    db.salvarLoja(loja.id, loja.nome, cfg);
    console.log(`🔒 ${u.email} ${b.bloquear ? "bloqueou" : "desbloqueou"} a loja ${loja.slug}`);
    return { ok: true, bloqueada: !!b.bloquear };
  },
});

// =====================================================================
// Planos e cobrança da plataforma: o Fluxofy cobra do lojista uma comissão
// sobre as vendas aprovadas (e mensalidade, se o plano tiver), por ciclo mensal.
// O dinheiro cai na conta Pagar.me DA PLATAFORMA (configurada no Admin).
// =====================================================================
const PLANOS_PADRAO = [{ id: "padrao", nome: "Padrão", mensalidadeCentavos: 0, comissaoPct: 1, padrao: true }];
const planos = () => { const l = db.lerPlataforma("planos", null); return Array.isArray(l) && l.length ? l : PLANOS_PADRAO; };
const planoPadrao = () => planos().find((p) => p.padrao) || planos()[0];
function cfgCobranca() {
  const c = db.lerPlataforma("cobranca", {}) || {};
  let sk = null; try { sk = c.chaveSecreta ? cofre.decifrar(c.chaveSecreta) : null; } catch {}
  return { chavePublica: c.chavePublica || "", chaveSecreta: sk, diasParaPagar: Number.isFinite(c.diasParaPagar) ? c.diasParaPagar : 5,
    ativa: !!(c.chavePublica && sk), testadoEm: c.testadoEm || null };
}
const clienteCobranca = () => { const c = cfgCobranca(); return c.ativa ? criarPagarme({ chavePublica: c.chavePublica, chaveSecreta: c.chaveSecreta }) : null; };
function maisUmMes(iso) {
  const d = new Date(iso), dia = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.toISOString();
}
const diasDepois = (iso, n) => new Date(new Date(iso).getTime() + n * 864e5).toISOString();
// Plano da loja; lojas antigas começam a ser cobradas a partir de agora (nada retroativo)
function planoDaLoja(loja, gravar = true) {
  const cfg = loja.config || {};
  if (!cfg.plano?.cicloInicio && gravar) {
    cfg.plano = { id: cfg.plano?.id || planoPadrao().id, cicloInicio: new Date().toISOString() };
    db.salvarLoja(loja.id, loja.nome, cfg); loja.config = cfg;
  }
  const p = planos().find((x) => x.id === cfg.plano?.id) || planoPadrao();
  return { ...p, cicloInicio: cfg.plano?.cicloInicio || new Date().toISOString() };
}
function calcular(loja, plano, inicio, fim) {
  const b = db.baseComissao(loja.id, inicio, fim);
  const comissao = Math.round((b.v * plano.comissaoPct) / 100);
  return { vendasCentavos: b.v, pedidos: b.n, comissaoCentavos: comissao, mensalidadeCentavos: plano.mensalidadeCentavos, totalCentavos: comissao + plano.mensalidadeCentavos };
}
// Fecha os ciclos vencidos de uma loja, gerando as faturas
function fecharCiclosDaLoja(loja, agoraIso = new Date().toISOString()) {
  const plano = planoDaLoja(loja);
  let inicio = plano.cicloInicio, novas = 0;
  const dias = cfgCobranca().diasParaPagar;
  while (maisUmMes(inicio) <= agoraIso) {
    const fim = maisUmMes(inicio), v = calcular(loja, plano, inicio, fim);
    const ok = db.criarFatura({ id: "FAT-" + crypto.randomBytes(5).toString("hex").toUpperCase(), lojaId: loja.id, plano: plano.nome, inicio, fim,
      comissaoPct: plano.comissaoPct, ...v, status: v.totalCentavos > 0 ? "aberta" : "isenta", venceEm: diasDepois(fim, dias) });
    if (ok) novas++;
    inicio = fim;
  }
  if (inicio !== plano.cicloInicio) { const cfg = loja.config; cfg.plano = { ...cfg.plano, cicloInicio: inicio }; db.salvarLoja(loja.id, loja.nome, cfg); }
  return novas;
}
function dadosCobranca(loja) {
  const d = loja.config?.cobranca?.dados || {};
  const u = db.usuarioPorId(loja.usuarioId) || {};
  return { nome: d.nome || "", documento: d.documento || "", telefone: d.telefone || "", email: u.email || "" };
}
function pedidoDaFatura(f, loja) {
  const d = dadosCobranca(loja);
  const per = `${new Date(f.inicio).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })} a ${new Date(f.fim).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;
  return { id: f.id, itens: [{ variantId: f.id, nome: `Fluxofy · ${f.plano} · ${per}`, quantidade: 1, precoCentavos: f.totalCentavos }], freteCentavos: 0,
    cliente: { nome: d.nome, email: d.email, cpf: d.documento, telefone: d.telefone }, endereco: null, customerId: loja.config?.cobranca?.customerId || null };
}
function salvarCobrancaLoja(loja, mudar) {
  const atual = db.lojaPorId(loja.id), cfg = atual.config;
  cfg.cobranca = { ...(cfg.cobranca || {}), ...mudar };
  db.salvarLoja(atual.id, atual.nome, cfg);
}
// Fatura paga: libera a loja se ela estava bloqueada só por fatura
function faturaPaga(f, metodo, pagamentoId) {
  if (!db.pagarFatura(f.id, metodo, pagamentoId)) return false;
  console.log(`💰 Fatura ${f.id} paga (${metodo})`);
  const loja = db.lojaPorId(f.lojaId), cfg = loja.config;
  const atrasada = db.faturasDaLoja(loja.id).some((x) => x.status === "aberta" && x.venceEm < new Date().toISOString());
  if (cfg.admin?.bloqueada && cfg.admin?.motivo === "fatura" && !atrasada) {
    cfg.admin = { ...cfg.admin, bloqueada: false, motivo: null, alteradoPor: "cobranca", alteradoEm: new Date().toISOString() };
    db.salvarLoja(loja.id, loja.nome, cfg); console.log(`🔓 Loja ${loja.slug} liberada após pagamento`);
  }
  return true;
}
async function conferirPagamentoFatura(f) {
  if (f.status !== "aberta" || !String(f.pagamentoId || "").startsWith("pgm:")) return f;
  const pg = clienteCobranca(); if (!pg) return f;
  const r = await pg.consultar(f.pagamentoId.slice(4)).catch(() => null);
  if (r?.status === "pago") faturaPaga(f, f.metodo || "pix", f.pagamentoId);
  return db.fatura(f.id);
}
async function cobrarComCartaoSalvo(f, loja) {
  const pg = clienteCobranca(), cartao = loja.config?.cobranca?.cartao;
  if (!pg || !cartao?.id) return null;
  try {
    const r = await pg.pagarCartao(pedidoDaFatura(f, loja), { cardId: cartao.id, totalCentavos: f.totalCentavos, softDescriptor: "FLUXOFY" });
    db.pagamentoFatura(f.id, "pgm:" + r.id, "cartao");
    if (r.status === "pago") { faturaPaga(f, "cartao", "pgm:" + r.id); return true; }
    db.tentativaFatura(f.id, r.motivo || r.bruto); return false;
  } catch (e) { db.tentativaFatura(f.id, e.message.slice(0, 200)); return false; }
}
// Rotina: fecha ciclos, tenta cobrar no cartão salvo e bloqueia quem passou do vencimento
async function rotinaCobranca() {
  for (const loja of db.todasLojas()) { try { fecharCiclosDaLoja(loja); } catch (e) { console.error("Fechar ciclo", loja.slug, e.message); } }
  const cob = cfgCobranca(), agora = new Date().toISOString();
  for (const f of db.faturasAbertas()) {
    let atual = await conferirPagamentoFatura(f).catch(() => f);
    if (atual.status !== "aberta") continue;
    const loja = db.lojaPorId(atual.lojaId); if (!loja) continue;
    const espera = !atual.ultimaTentativa || Date.now() - new Date(atual.ultimaTentativa).getTime() > 20 * 3600e3;
    if (cob.ativa && atual.tentativas < 4 && espera && loja.config?.cobranca?.cartao?.id) {
      if (await cobrarComCartaoSalvo(atual, loja)) continue;
    }
    // Sem a conta de cobrança configurada, ninguém é bloqueado
    const liberado = loja.config?.admin?.liberadoManualEm && Date.now() - new Date(loja.config.admin.liberadoManualEm).getTime() < 7 * 864e5;
    if (cob.ativa && atual.venceEm < agora && !loja.config?.admin?.bloqueada && !liberado) {
      const cfg = loja.config;
      cfg.admin = { ...(cfg.admin || {}), bloqueada: true, motivo: "fatura", faturaId: atual.id, alteradoPor: "cobranca", alteradoEm: agora };
      db.salvarLoja(loja.id, loja.nome, cfg); console.log(`🔒 Loja ${loja.slug} bloqueada: fatura ${atual.id} vencida`);
    }
  }
}
setInterval(() => rotinaCobranca().catch((e) => console.error("Cobrança:", e.message)), 10 * 60e3);
setTimeout(() => rotinaCobranca().catch((e) => console.error("Cobrança:", e.message)), 5000);

function resumoPlano(loja) {
  const plano = planoDaLoja(loja), fim = maisUmMes(plano.cicloInicio);
  const prev = calcular(loja, plano, plano.cicloInicio, fim), cob = cfgCobranca(), cfg = loja.config || {};
  return {
    plano: { id: plano.id, nome: plano.nome, mensalidadeCentavos: plano.mensalidadeCentavos, comissaoPct: plano.comissaoPct },
    ciclo: { inicio: plano.cicloInicio, fim, ...prev },
    faturas: db.faturasDaLoja(loja.id),
    cartao: cfg.cobranca?.cartao || null, dados: dadosCobranca(loja),
    cobrancaAtiva: cob.ativa, chavePublica: cob.ativa ? cob.chavePublica : null, diasParaPagar: cob.diasParaPagar,
    bloqueada: !!cfg.admin?.bloqueada, motivoBloqueio: cfg.admin?.motivo || null,
  };
}
function validarDadosCobranca(d) {
  const doc = String(d.documento || "").replace(/\D/g, ""), tel = String(d.telefone || "").replace(/\D/g, "");
  if (!d.nome || !documentoValido(doc)) return "Preencha o nome e um CPF ou CNPJ válido em Dados de cobrança";
  if (tel.length < 10) return "Preencha um telefone com DDD em Dados de cobrança";
  return null;
}
Object.assign(rotas, {
  "GET /api/painel/plano": async (req) => resumoPlano(exigirLojista(req).loja),
  "PUT /api/painel/plano/dados": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    const dados = { nome: String(b.nome || "").trim().slice(0, 80), documento: String(b.documento || "").replace(/\D/g, "").slice(0, 14), telefone: String(b.telefone || "").replace(/\D/g, "").slice(0, 13) };
    const msg = validarDadosCobranca(dados); if (msg) throw erro(400, msg);
    salvarCobrancaLoja(loja, { dados, customerId: null });
    return resumoPlano(db.lojaPorId(loja.id));
  },
  "POST /api/painel/fatura/pix": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    const f = db.fatura(String(b.id || ""));
    if (!f || f.lojaId !== loja.id) throw erro(404, "Fatura não encontrada");
    if (f.status !== "aberta") throw erro(400, "Esta fatura não está em aberto");
    const pg = clienteCobranca(); if (!pg) throw erro(400, "A cobrança da plataforma ainda não foi ativada. Fale com o suporte.");
    const msg = validarDadosCobranca(dadosCobranca(loja)); if (msg) throw erro(400, msg);
    const r = await pg.pagarPix(pedidoDaFatura(f, loja), { totalCentavos: f.totalCentavos, expiraSegundos: 24 * 3600 })
      .catch((e) => { throw erro(502, "Não foi possível gerar o Pix: " + e.message.slice(0, 160)); });
    db.pagamentoFatura(f.id, "pgm:" + r.id, "pix");
    if (r.customerId) salvarCobrancaLoja(loja, { customerId: r.customerId });
    return { copiaECola: r.copiaECola, qrCodeUrl: r.qrCodeUrl, expiraEm: r.expiraEm };
  },
  "POST /api/painel/fatura/cartao": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    const f = db.fatura(String(b.id || ""));
    if (!f || f.lojaId !== loja.id) throw erro(404, "Fatura não encontrada");
    if (f.status !== "aberta") throw erro(400, "Esta fatura não está em aberto");
    const pg = clienteCobranca(); if (!pg) throw erro(400, "A cobrança da plataforma ainda não foi ativada. Fale com o suporte.");
    const msg = validarDadosCobranca(dadosCobranca(loja)); if (msg) throw erro(400, msg);
    if (!b.token && !loja.config?.cobranca?.cartao?.id) throw erro(400, "Informe um cartão");
    let r;
    try {
      r = await pg.pagarCartao(pedidoDaFatura(f, loja), b.token ? { token: String(b.token), totalCentavos: f.totalCentavos, softDescriptor: "FLUXOFY", ip: ipDaRequisicao(req) }
        : { cardId: loja.config.cobranca.cartao.id, totalCentavos: f.totalCentavos, softDescriptor: "FLUXOFY" });
    } catch (e) { db.tentativaFatura(f.id, e.message.slice(0, 200)); throw erro(402, "Pagamento recusado. Confira os dados ou use outro cartão."); }
    db.pagamentoFatura(f.id, "pgm:" + r.id, "cartao");
    if (r.status !== "pago") { db.tentativaFatura(f.id, r.motivo || r.bruto); throw erro(402, r.motivo || "Pagamento recusado. Confira os dados ou use outro cartão."); }
    faturaPaga(f, "cartao", "pgm:" + r.id);
    // guarda o cartão para as próximas faturas
    if (b.token && b.salvar !== false && r.cartao) salvarCobrancaLoja(loja, { cartao: r.cartao, ...(r.customerId ? { customerId: r.customerId } : {}) });
    return resumoPlano(db.lojaPorId(loja.id));
  },
  "GET /api/painel/fatura": async (req, url) => {
    const { loja } = exigirLojista(req);
    let f = db.fatura(String(url.searchParams.get("id") || ""));
    if (!f || f.lojaId !== loja.id) throw erro(404, "Fatura não encontrada");
    f = await conferirPagamentoFatura(f);
    return { fatura: f, ...(f.status === "paga" ? resumoPlano(db.lojaPorId(loja.id)) : {}) };
  },
  "POST /api/painel/plano/cartao/remover": async (req) => {
    const { loja } = exigirLojista(req); await lerJson(req, true);
    salvarCobrancaLoja(loja, { cartao: null });
    return resumoPlano(db.lojaPorId(loja.id));
  },
  // Webhook da conta Pagar.me da plataforma (cadastrado pelo admin). Sempre confirma na API.
  "POST /webhook/cobranca": async (req) => {
    const b = await lerJson(req), d = b?.data || {};
    const orderId = String(d.id || "").startsWith("or_") ? d.id : d.order?.id;
    let f = orderId && db.faturaPorPagamento("pgm:" + orderId);
    if (!f && d.code) f = db.fatura(String(d.code));
    if (f) await conferirPagamentoFatura(f);
    return { ok: true };
  },

  // ---------- admin ----------
  "GET /api/admin/cobranca": async (req) => {
    exigirAdmin(req); const c = cfgCobranca();
    return { planos: planos(), chavePublica: c.chavePublica, chaveSecretaSalva: !!c.chaveSecreta, diasParaPagar: c.diasParaPagar, ativa: c.ativa, testadoEm: c.testadoEm,
      webhook: `${urlBase(req)}/webhook/cobranca`, faturas: db.faturasAdmin() };
  },
  "PUT /api/admin/cobranca": async (req) => {
    exigirAdmin(req); const b = await lerJson(req, true), atual = db.lerPlataforma("cobranca", {}) || {};
    const pk = String(b.chavePublica || "").trim(), sk = String(b.chaveSecreta || "").trim();
    if (pk && !/^pk_/.test(pk)) throw erro(400, "A chave pública da Pagar.me começa com pk_");
    if (sk && !/^sk_/.test(sk)) throw erro(400, "A chave secreta da Pagar.me começa com sk_");
    const novo = { ...atual, chavePublica: pk, diasParaPagar: Math.min(Math.max(parseInt(b.diasParaPagar, 10) || 0, 0), 60) };
    if (sk) novo.chaveSecreta = cofre.cifrar(sk);
    if (!pk) { novo.chaveSecreta = null; novo.testadoEm = null; }
    db.gravarPlataforma("cobranca", novo);
    return { ok: true };
  },
  "POST /api/admin/cobranca/testar": async (req) => {
    exigirAdmin(req); await lerJson(req, true);
    const pg = clienteCobranca(); if (!pg) return { ok: false, motivo: "Salve as duas chaves primeiro" };
    try { await pg.testar(); const c = db.lerPlataforma("cobranca", {}); c.testadoEm = new Date().toISOString(); db.gravarPlataforma("cobranca", c); return { ok: true }; }
    catch (e) { return { ok: false, motivo: e.message.slice(0, 300) }; }
  },
  "PUT /api/admin/planos": async (req) => {
    exigirAdmin(req); const b = await lerJson(req, true);
    const lista = (Array.isArray(b.planos) ? b.planos : []).slice(0, 10).map((p) => ({
      id: /^[a-z0-9-]{2,30}$/.test(p.id || "") ? p.id : crypto.randomBytes(4).toString("hex"), nome: String(p.nome || "").trim().slice(0, 40),
      mensalidadeCentavos: Math.round(Math.min(Math.max(Number(String(p.mensalidade ?? 0).replace(",", ".")) || 0, 0), 100000) * 100),
      comissaoPct: Math.min(Math.max(Number(String(p.comissaoPct ?? 0).replace(",", ".")) || 0, 0), 30), padrao: !!p.padrao,
    }));
    if (!lista.length || lista.some((p) => !p.nome)) throw erro(400, "Dê um nome para cada plano");
    if (!lista.some((p) => p.padrao)) lista[0].padrao = true;
    lista.forEach((p, i) => { if (p.padrao && lista.findIndex((x) => x.padrao) !== i) p.padrao = false; });
    db.gravarPlataforma("planos", lista);
    return { ok: true, planos: lista };
  },
  "PUT /api/admin/loja/plano": async (req) => {
    exigirAdmin(req); const b = await lerJson(req, true);
    const loja = db.lojaPorId(String(b.id || "")); if (!loja) throw erro(404, "Loja não encontrada");
    if (!planos().some((p) => p.id === b.plano)) throw erro(400, "Plano inválido");
    const cfg = loja.config; planoDaLoja(loja); cfg.plano = { ...cfg.plano, id: b.plano }; db.salvarLoja(loja.id, loja.nome, cfg);
    return { ok: true };
  },
  "POST /api/admin/fatura/status": async (req) => {
    const u = exigirAdmin(req), b = await lerJson(req, true);
    const f = db.fatura(String(b.id || "")); if (!f) throw erro(404, "Fatura não encontrada");
    if (b.status === "paga") { if (!faturaPaga(f, "manual", null)) throw erro(400, "A fatura não está em aberto"); }
    else if (["isenta", "cancelada"].includes(b.status)) {
      if (f.status !== "aberta") throw erro(400, "A fatura não está em aberto");
      db.statusFatura(f.id, b.status, `por ${u.email}`);
      const loja = db.lojaPorId(f.lojaId), cfg = loja.config;
      const atrasada = db.faturasDaLoja(loja.id).some((x) => x.status === "aberta" && x.venceEm < new Date().toISOString());
      if (cfg.admin?.motivo === "fatura" && !atrasada) { cfg.admin = { ...cfg.admin, bloqueada: false, motivo: null }; db.salvarLoja(loja.id, loja.nome, cfg); }
    } else throw erro(400, "Status inválido");
    return { ok: true };
  },
  "POST /api/admin/cobranca/rodar": async (req) => { exigirAdmin(req); await rotinaCobranca(); return { ok: true }; },
});

// =====================================================================
// E-mails transacionais
// =====================================================================
const { EVENTOS: EVENTOS_EMAIL, VARIAVEIS: VARIAVEIS_EMAIL, montar: montarEmail, enviarResend, EXEMPLO: EXEMPLO_EMAIL } = require("./emails");
function cfgEmailPlataforma() {
  const c = db.lerPlataforma("email", {}) || {};
  let key = null; try { key = c.apiKey ? cofre.decifrar(c.apiKey) : null; } catch {}
  return { apiKey: key, remetente: c.remetente || "", ativo: !!(key && c.remetente) };
}
// Endereço público (para links nos e-mails), sem depender de uma requisição
function urlPublica() {
  if (env.URL_PUBLICA) return env.URL_PUBLICA.replace(/\/$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return "https://" + env.RAILWAY_PUBLIC_DOMAIN;
  return db.lerPlataforma("url_publica", "") || "";
}
function cfgEmailLoja(loja) {
  const c = loja.config?.emails || {}, ev = {};
  for (const [k, d] of Object.entries(EVENTOS_EMAIL)) {
    const s = c.eventos?.[k] || {};
    ev[k] = { ativo: s.ativo ?? true, assunto: s.assunto || d.assunto, corpo: s.corpo || d.corpo, personalizado: !!(s.assunto || s.corpo),
      ...(d.atraso ? { atrasoMin: Number.isFinite(s.atrasoMin) ? s.atrasoMin : 30 } : {}) };
  }
  const dono = db.usuarioPorId(loja.usuarioId) || {};
  return { nomeRemetente: c.nomeRemetente || loja.nome, responderPara: c.responderPara || dono.email || "", emailLojista: c.emailLojista || dono.email || "", eventos: ev };
}
const pagamentoTxt = (p) => p.metodo === "pix" ? "Pix" : `Cartão${p.parcelas > 1 ? ` ${p.parcelas}x` : " à vista"}`;
function dadosDoPedido(p, loja, extra = {}) {
  return { loja: loja.nome, pedido: p.shopifyPedido || p.id, totalCentavos: p.totalCentavos, pagamento: pagamentoTxt(p), cliente: p.cliente,
    itens: p.itens, endereco: p.endereco, ...extra };
}
/** Envia (no máximo uma vez por evento+chave). Sem provedor configurado, registra como "simulado". */
async function enviarEmailEvento(loja, evento, chave, dados, para) {
  if (!loja || !para || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(para)) return;
  const ce = cfgEmailLoja(loja), ev = ce.eventos[evento];
  if (!ev?.ativo) return;
  const m = montarEmail(ev, dados, loja.config?.marca);
  const id = "EM-" + crypto.randomBytes(6).toString("hex");
  if (!db.reservarEmail({ id, lojaId: loja.id, evento, chave, para, assunto: m.assunto })) return; // já enviado
  const pl = cfgEmailPlataforma();
  if (!pl.ativo) return db.concluirEmail(id, "simulado", "Envio de e-mails não configurado na plataforma");
  try {
    const nome = ce.nomeRemetente.replace(/[<>"\r\n]/g, "").slice(0, 60);
    const pid = await enviarResend({ apiKey: pl.apiKey, de: `${nome} <${pl.remetente}>`, para, responderPara: ce.responderPara, assunto: m.assunto, html: m.html, texto: m.texto });
    db.concluirEmail(id, "enviado", null, pid);
  } catch (e) { db.concluirEmail(id, "erro", e.message.slice(0, 300)); console.error("E-mail", evento, e.message); }
}
function emailsDoPedido(evento, pedidoId, extra = {}) {
  setImmediate(async () => {
    try {
      const p = db.buscar(pedidoId); if (!p?.lojaId) return;
      const loja = db.lojaPorId(p.lojaId); if (!loja) return;
      if (evento === "pedido_aprovado") {
        await enviarEmailEvento(loja, "pedido_aprovado", p.id, dadosDoPedido(p, loja), p.cliente?.email);
        await enviarEmailEvento(loja, "nova_venda", p.id, dadosDoPedido(p, loja), cfgEmailLoja(loja).emailLojista);
      } else if (evento === "pix_gerado") {
        await enviarEmailEvento(loja, "pix_gerado", p.id, dadosDoPedido(p, loja, { pix: extra.pix }), p.cliente?.email);
      } else if (evento === "reembolso") {
        await enviarEmailEvento(loja, "reembolso", `${p.id}:${extra.chave}`, dadosDoPedido(p, loja, { valorReembolsoCentavos: extra.valor }), p.cliente?.email);
      }
    } catch (e) { console.error("E-mail do pedido", evento, e.message); }
  });
}
// Carrinhos abandonados: envia depois do atraso configurado (até 3 dias de idade)
async function rotinaEmailsAbandono() {
  const base = urlPublica(); if (!base) return;
  const agora = Date.now();
  for (const a of db.abandonosParaEmail(new Date(agora - 5 * 60e3).toISOString(), new Date(agora - 3 * 864e5).toISOString())) {
    const loja = db.lojaPorId(a.lojaId); if (!loja || loja.config?.admin?.bloqueada) continue;
    const ev = cfgEmailLoja(loja).eventos.carrinho_abandonado;
    if (!ev.ativo || agora - new Date(a.atualizadoEm).getTime() < ev.atrasoMin * 60e3) continue;
    let itens = [];
    try { itens = (await montarCarrinho(contexto(loja), a.carrinho)).itens; } catch {}
    if (!itens.length && a.carrinho.resumo) itens = [{ nome: a.carrinho.resumo, quantidade: 1, precoCentavos: a.totalCentavos }];
    await enviarEmailEvento(loja, "carrinho_abandonado", a.id, { loja: loja.nome, cliente: a.cliente, itens, totalCentavos: a.totalCentavos,
      linkCheckout: `${base}/checkout?loja=${loja.slug}&rec=${a.id}` }, a.cliente?.email);
  }
}
setInterval(() => rotinaEmailsAbandono().catch((e) => console.error("E-mails abandono:", e.message)), 5 * 60e3);

Object.assign(rotas, {
  "GET /api/painel/emails": async (req) => {
    const { loja } = exigirLojista(req);
    db.gravarPlataforma("url_publica", urlBase(req));
    const pl = cfgEmailPlataforma();
    return { config: cfgEmailLoja(loja), eventos: Object.fromEntries(Object.entries(EVENTOS_EMAIL).map(([k, d]) => [k, { nome: d.nome, para: d.para, descricao: d.descricao, atraso: !!d.atraso, assunto: d.assunto, corpo: d.corpo }])),
      variaveis: VARIAVEIS_EMAIL, historico: db.emailsDaLoja(loja.id), envioAtivo: pl.ativo, remetente: pl.remetente,
      shopifyConfirmacao: !!(loja.config?.shopify?.enviarConfirmacao && loja.config?.shopify?.loja) };
  },
  "PUT /api/painel/emails": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    const cfg = loja.config, atual = cfg.emails || {};
    const novo = { ...atual, eventos: { ...(atual.eventos || {}) } };
    if (b.remetente) {
      const r = b.remetente, email = (v) => { v = String(v || "").trim(); if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw erro(400, "E-mail inválido: " + v); return v.slice(0, 120); };
      novo.nomeRemetente = String(r.nomeRemetente || "").replace(/[<>"\r\n]/g, "").trim().slice(0, 60);
      novo.responderPara = email(r.responderPara); novo.emailLojista = email(r.emailLojista);
    }
    if (b.evento) {
      if (!EVENTOS_EMAIL[b.evento]) throw erro(400, "E-mail desconhecido");
      const e = { ...(novo.eventos[b.evento] || {}) }, d = EVENTOS_EMAIL[b.evento];
      if ("ativo" in b) e.ativo = !!b.ativo;
      if ("assunto" in b) { const v = String(b.assunto || "").replace(/[\r\n]/g, " ").trim().slice(0, 200); e.assunto = v && v !== d.assunto ? v : undefined; }
      if ("corpo" in b) { const v = String(b.corpo || "").trim().slice(0, 6000); e.corpo = v && v !== d.corpo.trim() ? v : undefined; }
      if ("atrasoMin" in b && d.atraso) e.atrasoMin = Math.min(Math.max(parseInt(b.atrasoMin, 10) || 30, 10), 1440);
      if (b.restaurar) { delete e.assunto; delete e.corpo; }
      novo.eventos[b.evento] = e;
    }
    cfg.emails = novo; db.salvarLoja(loja.id, loja.nome, cfg);
    return { ok: true, config: cfgEmailLoja(db.lojaPorId(loja.id)) };
  },
  "POST /api/painel/emails/previa": async (req) => {
    const { loja } = exigirLojista(req), b = await lerJson(req, true);
    if (!EVENTOS_EMAIL[b.evento]) throw erro(400, "E-mail desconhecido");
    const d = EVENTOS_EMAIL[b.evento];
    return montarEmail({ assunto: b.assunto || d.assunto, corpo: b.corpo || d.corpo }, { ...EXEMPLO_EMAIL, loja: loja.nome }, loja.config?.marca);
  },
  "POST /api/painel/emails/teste": async (req) => {
    const { loja, usuario } = exigirLojista(req), b = await lerJson(req, true);
    limitar(req, "email-teste", 10, 60 * 60e3);
    if (!EVENTOS_EMAIL[b.evento]) throw erro(400, "E-mail desconhecido");
    const pl = cfgEmailPlataforma(); if (!pl.ativo) throw erro(400, "O envio de e-mails ainda não foi ativado na plataforma.");
    const d = EVENTOS_EMAIL[b.evento], ce = cfgEmailLoja(loja);
    const m = montarEmail({ assunto: b.assunto || d.assunto, corpo: b.corpo || d.corpo }, { ...EXEMPLO_EMAIL, loja: loja.nome }, loja.config?.marca);
    try { await enviarResend({ apiKey: pl.apiKey, de: `${ce.nomeRemetente.replace(/[<>"\r\n]/g, "")} <${pl.remetente}>`, para: usuario.email, responderPara: ce.responderPara, assunto: "[Teste] " + m.assunto, html: m.html, texto: m.texto }); }
    catch (e) { throw erro(502, "O provedor recusou o envio: " + e.message.slice(0, 200)); }
    return { ok: true, para: usuario.email };
  },
  "GET /api/admin/email": async (req) => { exigirAdmin(req); const c = cfgEmailPlataforma(); return { remetente: c.remetente, chaveSalva: !!c.apiKey, ativo: c.ativo }; },
  "PUT /api/admin/email": async (req) => {
    exigirAdmin(req); const b = await lerJson(req, true), atual = db.lerPlataforma("email", {}) || {};
    const rem = String(b.remetente || "").trim();
    if (rem && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rem)) throw erro(400, "E-mail do remetente inválido");
    const k = String(b.apiKey || "").trim();
    if (k && !/^re_/.test(k)) throw erro(400, "A chave do Resend começa com re_");
    db.gravarPlataforma("email", { ...atual, remetente: rem, ...(k ? { apiKey: cofre.cifrar(k) } : {}), ...(!rem && !k ? { apiKey: null } : {}) });
    return { ok: true };
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
      if (r && r._arquivo) {
        res.writeHead(200, { "Content-Type": r._arquivo.tipo, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        return res.end(r._arquivo.dados);
      }
      if (r && r._redirect) { res.writeHead(302, { Location: r._redirect, "Cache-Control": "no-store" }); return res.end(); }
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
  if (!PERSISTENTE) console.log("⚠️  SEM VOLUME: contas e logins serão apagados a cada publicação. No Railway, adicione um Volume com Mount Path /data.");
  console.log(appmaxApp.configurado ? `Appmax:  app ${APPMAX.appId} (${APPMAX.ambiente})` : "Appmax:  app não configurado (APPMAX_APP_ID, APPMAX_CLIENT_ID, APPMAX_CLIENT_SECRET)");
  console.log(ADMINS.length ? `Admins:  ${ADMINS.join(", ")}` : "⚠️  Nenhum admin: defina ADMIN_EMAILS com o seu e-mail");
});

// Conciliação a cada 5 min: Pix pendentes (caso o webhook se perca) e pedidos que não chegaram à Shopify
async function conciliar() {
  for (const p of db.pendentesDesde(new Date(Date.now() - 864e5).toISOString())) await consultarGateway(p, "conciliacao");
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
function lerJson(req, exigirJson = false, limite = 1e5) {
  if (exigirJson && !String(req.headers["content-type"] || "").includes("application/json")) return Promise.reject(erro(415, "Envie JSON"));
  return new Promise((resolve, reject) => {
    let corpo = "";
    req.on("data", (c) => { corpo += c; if (corpo.length > limite) { reject(erro(413, "Arquivo grande demais")); req.destroy(); } });
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
