// Checkout transparente com Cielo + Shopify — servidor sem dependências (Node 18+)
// Rodar: node server.js   →  http://localhost:3000/                           (site)
//                            http://localhost:3000/checkout?itens=111:2,222:1  (carrinho Shopify)
//                            http://localhost:3000/checkout?produto=curso-pro   (produto avulso)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { criarCielo, traduzirStatus } = require("./cielo");
const { criarShopify } = require("./shopify");
const { abrirBanco } = require("./db");

// ---------- Configuração (.env ou variáveis de ambiente da hospedagem) ----------
const env = process.env;
carregarEnv(path.join(__dirname, ".env"));
const cfg = {
  porta: Number(env.PORT || 3000),
  ambiente: env.CIELO_AMBIENTE || "sandbox",
  merchantId: env.CIELO_MERCHANT_ID,
  merchantKey: env.CIELO_MERCHANT_KEY,
  sopClientId: env.CIELO_SOP_CLIENT_ID,
  sopClientSecret: env.CIELO_SOP_CLIENT_SECRET,
  softDescriptor: env.SOFT_DESCRIPTOR || "MINHALOJA",
  maxParcelas: Number(env.MAX_PARCELAS || 12),
  parcelasSemJuros: Number(env.PARCELAS_SEM_JUROS || 1),
  jurosMes: Number(env.JUROS_MES || 2.99) / 100,
  freteFixo: Math.round(Number(env.FRETE_FIXO || 0) * 100),
  freteGratisAcima: Math.round(Number(env.FRETE_GRATIS_ACIMA || 0) * 100),
  lojaUrl: env.LOJA_URL || "", // ex.: https://sualoja.com.br (link de "voltar para a loja")
};
const SIMULACAO = !cfg.merchantId || !cfg.merchantKey;
const cielo = SIMULACAO ? null : criarCielo(cfg);
const shopify = env.SHOPIFY_LOJA && env.SHOPIFY_TOKEN
  ? criarShopify({ loja: env.SHOPIFY_LOJA, token: env.SHOPIFY_TOKEN, versao: env.SHOPIFY_API_VERSION })
  : null;

// ---------- Dados ----------
// Produtos avulsos (infoproduto, link direto). Carrinhos da Shopify não usam esta lista.
const PRODUTOS = {
  "curso-pro": { nome: "Curso Pro de Marketing Digital", precoCentavos: 49700 },
};
// Catálogo falso usado só quando a Shopify ainda não está configurada (para testar o fluxo)
const SHOPIFY_FALSO = {
  "111": { nome: "Camiseta Básica — M", precoCentavos: 8990 },
  "222": { nome: "Boné Aba Curva — Preto", precoCentavos: 6990 },
};
const db = abrirBanco(env.DB_ARQUIVO || path.join(__dirname, "dados", "checkout.db"));
const ADMIN_TOKEN = env.ADMIN_TOKEN || "";

// ---------- Carrinho: preços SEMPRE vêm do servidor ----------
async function montarCarrinho({ itens, produtoId }) {
  let lista, fisico;
  if (itens) {
    const pares = String(itens).split(",").slice(0, 50).map((par) => {
      const [variantId, q] = par.split(":");
      const quantidade = Math.min(Math.max(parseInt(q, 10) || 1, 1), 99);
      if (!/^\d+$/.test(variantId || "")) throw erro(400, "Carrinho inválido");
      return { variantId, quantidade };
    });
    if (!pares.length) throw erro(400, "Carrinho vazio");
    lista = shopify
      ? await shopify.buscarItens(pares)
      : pares.map((p) => {
          const f = SHOPIFY_FALSO[p.variantId];
          if (!f) throw erro(400, `Variante ${p.variantId} não existe (Shopify não configurada; use 111 ou 222)`);
          return { ...p, gid: `gid://shopify/ProductVariant/${p.variantId}`, imagem: null, ...f };
        });
    fisico = true;
  } else {
    const p = PRODUTOS[produtoId];
    if (!p) throw erro(404, "Produto não encontrado");
    lista = [{ variantId: produtoId, quantidade: 1, imagem: null, ...p }];
    fisico = false;
  }
  const subtotal = lista.reduce((s, i) => s + i.precoCentavos * i.quantidade, 0);
  const frete = !fisico || (cfg.freteGratisAcima && subtotal >= cfg.freteGratisAcima) ? 0 : cfg.freteFixo;
  return { itens: lista, subtotalCentavos: subtotal, freteCentavos: frete, totalCentavos: subtotal + frete, precisaEndereco: fisico, shopify: fisico };
}

function opcoesParcelamento(valor) {
  const opcoes = [];
  for (let n = 1; n <= cfg.maxParcelas; n++) {
    let total = valor;
    if (n > cfg.parcelasSemJuros && cfg.jurosMes > 0) {
      const i = cfg.jurosMes;
      total = Math.round(((valor * i) / (1 - Math.pow(1 + i, -n))) * n);
    }
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
  for (const [k, nome] of [["rua", "rua"], ["numero", "número"], ["bairro", "bairro"], ["cidade", "cidade"]])
    if (!String(e[k] || "").trim()) return `Informe ${nome}`;
  if (!/^[A-Z]{2}$/.test(String(e.uf || "").toUpperCase())) return "UF inválida";
  return null;
}
function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (len) => { let s = 0; for (let i = 0; i < len; i++) s += Number(cpf[i]) * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
}

async function prepararPedido(body, metodo) {
  const carrinho = await montarCarrinho(body.carrinho || {});
  const msg = validarCliente(body.cliente) || (carrinho.precisaEndereco && validarEndereco(body.endereco));
  if (msg) throw erro(400, msg);
  const c = body.cliente, e = body.endereco || {};
  return {
    id: "PED-" + crypto.randomBytes(5).toString("hex").toUpperCase(),
    metodo, parcelas: 1, status: "criado", paymentId: null, shopifyPedido: null, criadoEm: new Date().toISOString(),
    cliente: { nome: c.nome.trim(), email: c.email.trim(), cpf: String(c.cpf).replace(/\D/g, ""), telefone: c.telefone || "" },
    endereco: carrinho.precisaEndereco ? { ...e, cep: String(e.cep).replace(/\D/g, "").replace(/(\d{5})(\d{3})/, "$1-$2"), uf: String(e.uf).toUpperCase() } : null,
    itens: carrinho.itens, freteCentavos: carrinho.freteCentavos, totalCentavos: carrinho.totalCentavos, enviarParaShopify: carrinho.shopify,
  };
}

// Aplica o status vindo da Cielo. A transição para "pago" é atômica no banco:
// mesmo que webhook e consulta cheguem juntos, o pedido só vai uma vez para a Shopify.
async function atualizarStatus(id, statusCielo, origem) {
  const novo = traduzirStatus(statusCielo);
  db.evento(id, "status", `${origem}: Cielo ${statusCielo} → ${novo}`);
  if (novo === "pago") {
    if (db.marcarPago(id)) {
      console.log(`✅ ${id} PAGO (${origem})`);
      await enviarParaShopify(id);
    }
  } else db.definirStatus(id, novo);
  return db.buscar(id);
}

async function enviarParaShopify(id) {
  const p = db.buscar(id);
  if (!p || p.status !== "pago" || !p.enviarParaShopify || p.shopifyPedido) return; // produto avulso: libere o acesso aqui
  if (!shopify) return db.evento(id, "shopify_pulado", "Shopify não configurada");
  try {
    const ordem = await shopify.criarPedido(p);
    db.shopifyOk(id, ordem.name);
    console.log(`   → Shopify ${ordem.name}`);
  } catch (e) {
    // O pagamento já foi aprovado: NÃO estorna. Fica registrado para reprocessar.
    db.shopifyErro(id, e.message);
    console.error(`   ❌ Shopify falhou para ${id}: ${e.message}`);
  }
}

function exigirAdmin(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!ADMIN_TOKEN || t.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN)))
    throw erro(401, "Não autorizado");
}

// ---------- Rotas ----------
const rotas = {
  "GET /api/config": async () => ({ modo: SIMULACAO ? "simulacao" : "cielo", ambiente: cfg.ambiente, sopScript: SIMULACAO ? null : cielo.sopScript, shopify: !!shopify, lojaUrl: cfg.lojaUrl }),

  "GET /api/carrinho": async (req, url) => {
    const c = await montarCarrinho({ itens: url.searchParams.get("itens"), produtoId: url.searchParams.get("produto") });
    return { ...c, itens: c.itens.map(({ gid, ...i }) => i), parcelamento: opcoesParcelamento(c.totalCentavos) };
  },

  "POST /api/sop-token": async () => ({ accessToken: SIMULACAO ? "SIMULACAO" : await cielo.gerarAccessTokenSOP() }),

  "POST /api/pagar/cartao": async (req) => {
    const body = await lerJson(req);
    const pedido = await prepararPedido(body, "cartao");
    const opcao = opcoesParcelamento(pedido.totalCentavos).find((o) => o.parcelas === Number(body.parcelas));
    if (!opcao) throw erro(400, "Parcelamento inválido");
    if (!body.paymentToken) throw erro(400, "Token do cartão ausente");
    pedido.parcelas = opcao.parcelas;
    pedido.totalCentavos = opcao.totalCentavos;
    db.criar(pedido);

    if (SIMULACAO) {
      db.definirPayment(pedido.id, "SIM-" + crypto.randomUUID());
      const atual = await atualizarStatus(pedido.id, ["0", "1", "4"].includes(String(body.paymentToken).slice(-1)) ? 2 : 3, "cartao");
      return resposta(atual, atual.status === "pago" ? null : "Transação não autorizada (simulação)");
    }
    const venda = await cielo.venderCartao({
      pedidoId: pedido.id, cliente: pedido.cliente, valorCentavos: pedido.totalCentavos, parcelas: pedido.parcelas,
      paymentToken: body.paymentToken, bandeira: body.bandeira, softDescriptor: cfg.softDescriptor,
    });
    db.definirPayment(pedido.id, venda.Payment.PaymentId);
    db.evento(pedido.id, "cielo_cartao", `ReturnCode ${venda.Payment.ReturnCode} ${venda.Payment.ReturnMessage || ""}`);
    const atual = await atualizarStatus(pedido.id, venda.Payment.Status, "cartao");
    return resposta(atual, atual.status === "pago" ? null : venda.Payment.ReturnMessage || "Pagamento recusado");
  },

  "POST /api/pagar/pix": async (req) => {
    const pedido = await prepararPedido(await lerJson(req), "pix");
    db.criar(pedido);
    if (SIMULACAO) {
      db.definirPayment(pedido.id, "SIM-" + crypto.randomUUID());
      db.definirStatus(pedido.id, "pendente");
      return { ...resposta(db.buscar(pedido.id)), pix: { qrCodeBase64: null, copiaECola: `00020126SIMULACAO${pedido.id}5204000053039865802BR6304ABCD` } };
    }
    const venda = await cielo.venderPix({ pedidoId: pedido.id, cliente: pedido.cliente, valorCentavos: pedido.totalCentavos });
    db.definirPayment(pedido.id, venda.Payment.PaymentId);
    const atual = await atualizarStatus(pedido.id, venda.Payment.Status, "pix");
    return { ...resposta(atual), pix: { qrCodeBase64: venda.Payment.QrCodeBase64Image, copiaECola: venda.Payment.QrCodeString } };
  },

  "GET /api/pedido": async (req, url) => {
    let pedido = db.buscar(url.searchParams.get("id"));
    if (!pedido) throw erro(404, "Pedido não encontrado");
    if (!SIMULACAO && pedido.status === "pendente" && pedido.paymentId) {
      const venda = await cielo.consultar(pedido.paymentId).catch(() => null);
      if (venda) pedido = await atualizarStatus(pedido.id, venda.Payment.Status, "consulta");
    }
    return resposta(pedido);
  },

  // Post de Notificação da Cielo: cadastre https://SEU-DOMINIO/webhook/cielo
  "POST /webhook/cielo": async (req) => {
    const { PaymentId, ChangeType } = await lerJson(req);
    const pedido = PaymentId && db.buscarPorPayment(PaymentId);
    if (pedido) {
      db.evento(pedido.id, "webhook", `ChangeType ${ChangeType}`);
      if (!SIMULACAO) await atualizarStatus(pedido.id, (await cielo.consultar(PaymentId)).Payment.Status, "webhook");
    }
    return { ok: true };
  },

  "POST /api/simular/pix-pago": async (req, url) => {
    if (!SIMULACAO) throw erro(403, "Disponível só no modo simulação");
    const pedido = db.buscar(url.searchParams.get("id"));
    if (!pedido) throw erro(404, "Pedido não encontrado");
    return resposta(await atualizarStatus(pedido.id, 2, "simulacao"));
  },

  // ---------- Administração (header Authorization: Bearer ADMIN_TOKEN) ----------
  "GET /admin/pedidos": async (req, url) => {
    exigirAdmin(req);
    return db.listar(Math.min(Number(url.searchParams.get("limite")) || 50, 500))
      .map((p) => ({ id: p.id, status: p.status, metodo: p.metodo, totalCentavos: p.totalCentavos, email: p.cliente.email, shopify: p.shopifyPedido, erroShopify: p.erroShopify, criadoEm: p.criadoEm }));
  },
  "GET /admin/pedido": async (req, url) => {
    exigirAdmin(req);
    const p = db.buscar(url.searchParams.get("id"));
    if (!p) throw erro(404, "Pedido não encontrado");
    return { ...p, eventos: db.eventos(p.id) };
  },
  // Reenvia para a Shopify os pedidos pagos que falharam (ou só ?id=PED-...)
  "POST /admin/reprocessar-shopify": async (req, url) => {
    exigirAdmin(req);
    const id = url.searchParams.get("id");
    const lista = id ? [db.buscar(id)].filter(Boolean) : db.comErroShopify();
    for (const p of lista) await enviarParaShopify(p.id);
    return lista.map((p) => { const a = db.buscar(p.id); return { id: a.id, shopify: a.shopifyPedido, erro: a.erroShopify }; });
  },

  "GET /saude": async () => ({ ok: true, modo: SIMULACAO ? "simulacao" : cfg.ambiente, shopify: !!shopify }),
};

function resposta(p, mensagem = null) {
  return { pedidoId: p.id, status: p.status, metodo: p.metodo, totalCentavos: p.totalCentavos, parcelas: p.parcelas, shopifyPedido: p.shopifyPedido || null, mensagem };
}

// ---------- Servidor HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const rota = rotas[`${req.method} ${url.pathname}`];
  try {
    if (rota) return enviar(res, 200, await rota(req, url));
    if (req.method === "GET") return servirArquivo(res, url.pathname);
    enviar(res, 404, { erro: "Não encontrado" });
  } catch (e) {
    if (!e.status) console.error(e);
    enviar(res, e.status || 502, { erro: e.status ? e.message : "Erro ao processar. Tente novamente." });
  }
}).listen(cfg.porta, () => {
  console.log(`Site:     http://localhost:${cfg.porta}/`);
  console.log(`Checkout: http://localhost:${cfg.porta}/checkout?itens=111:2,222:1`);
  console.log(SIMULACAO ? "⚠️  Cielo: MODO SIMULAÇÃO" : `Cielo: ${cfg.ambiente}`);
  console.log(shopify ? `Shopify: ${env.SHOPIFY_LOJA}` : "⚠️  Shopify: não configurada (catálogo de teste 111/222)");
});

// Conciliação a cada 5 min: Pix pendentes das últimas 24h (caso o webhook se perca)
// e pedidos pagos que ainda não chegaram na Shopify.
async function conciliar() {
  if (!SIMULACAO) {
    for (const p of db.pendentesDesde(new Date(Date.now() - 864e5).toISOString())) {
      const venda = await cielo.consultar(p.paymentId).catch(() => null);
      if (venda) await atualizarStatus(p.id, venda.Payment.Status, "conciliacao");
    }
  }
  if (shopify) for (const p of db.comErroShopify()) await enviarParaShopify(p.id);
}
setInterval(() => conciliar().catch((e) => console.error("conciliação:", e.message)), 5 * 60 * 1000).unref();
for (const sinal of ["SIGINT", "SIGTERM"]) process.on(sinal, () => { db.fechar(); process.exit(0); });

function servirArquivo(res, p) {
  const base = path.join(__dirname, "public");
  const nomes = { "/": "index.html", "/checkout": "checkout.html", "/checkout/": "checkout.html" };
  const arquivo = path.join(base, nomes[p] || path.normalize(p));
  if (!arquivo.startsWith(base)) return enviar(res, 403, { erro: "Proibido" });
  fs.readFile(arquivo, (err, dados) => {
    if (err) return enviar(res, 404, { erro: "Não encontrado" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(arquivo)] || "application/octet-stream" });
    res.end(dados);
  });
}
function enviar(res, status, corpo) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(corpo)); }
function lerJson(req) {
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
