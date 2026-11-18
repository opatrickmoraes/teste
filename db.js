// Banco de dados SQLite embutido no Node 22.5+ (node:sqlite) — sem dependências.
// Um arquivo só (DB_ARQUIVO). Em hospedagem, deixe-o num disco/volume persistente.

const fs = require("fs");
const path = require("path");
process.removeAllListeners("warning"); // esconde o aviso "experimental" do node:sqlite
const { DatabaseSync } = require("node:sqlite");

function abrirBanco(arquivo) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, nome TEXT NOT NULL,
      senha_hash TEXT NOT NULL, criado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      token_hash TEXT PRIMARY KEY, usuario_id TEXT NOT NULL, expira_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lojas (
      id TEXT PRIMARY KEY, usuario_id TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL, config TEXT NOT NULL,      -- JSON; chaves secretas cifradas ("enc:...")
      criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, metodo TEXT NOT NULL,
      parcelas INTEGER NOT NULL DEFAULT 1, total_centavos INTEGER NOT NULL,
      frete_centavos INTEGER NOT NULL DEFAULT 0, payment_id TEXT,
      cliente TEXT NOT NULL, endereco TEXT, itens TEXT NOT NULL,
      enviar_shopify INTEGER NOT NULL DEFAULT 0, shopify_pedido TEXT, shopify_erro TEXT,
      criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS abandonos (
      id TEXT PRIMARY KEY,                  -- também é o token do link de recuperação
      loja_id TEXT NOT NULL, sessao TEXT NOT NULL, cliente TEXT NOT NULL, carrinho TEXT NOT NULL,
      total_centavos INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'aberto',  -- aberto | recuperado
      pedido_id TEXT, contatado_em TEXT, via_link INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY, loja_id TEXT NOT NULL, titulo TEXT NOT NULL, descricao TEXT,
      valor_centavos INTEGER NOT NULL, pedir_endereco INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plataforma (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS faturas (
      id TEXT PRIMARY KEY, loja_id TEXT NOT NULL, plano TEXT NOT NULL, inicio TEXT NOT NULL, fim TEXT NOT NULL,
      vendas_centavos INTEGER NOT NULL, pedidos INTEGER NOT NULL, comissao_pct REAL NOT NULL,
      mensalidade_centavos INTEGER NOT NULL, comissao_centavos INTEGER NOT NULL, total_centavos INTEGER NOT NULL,
      status TEXT NOT NULL, vence_em TEXT NOT NULL, pago_em TEXT, metodo TEXT, pagamento_id TEXT, tentativas INTEGER NOT NULL DEFAULT 0,
      ultima_tentativa TEXT, obs TEXT, criado_em TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS faturas_ciclo ON faturas(loja_id, inicio);
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY, loja_id TEXT NOT NULL, evento TEXT NOT NULL, chave TEXT NOT NULL, para TEXT NOT NULL,
      assunto TEXT NOT NULL, status TEXT NOT NULL, erro TEXT, provedor_id TEXT, criado_em TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS emails_unico ON emails(evento, chave);
    CREATE INDEX IF NOT EXISTS emails_loja ON emails(loja_id, criado_em);
    CREATE TABLE IF NOT EXISTS conquistas (
      loja_id TEXT NOT NULL, nivel INTEGER NOT NULL, meta_centavos INTEGER NOT NULL,
      atingido_em TEXT NOT NULL, entregue_em TEXT, PRIMARY KEY (loja_id, nivel)
    );
    CREATE TABLE IF NOT EXISTS eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id TEXT NOT NULL,
      tipo TEXT NOT NULL, detalhe TEXT, criado_em TEXT NOT NULL
    );
  `);
  // Colunas novas (bancos criados por versões anteriores)
  for (const sql of [
    "ALTER TABLE pedidos ADD COLUMN loja_id TEXT",
    "ALTER TABLE pedidos ADD COLUMN shopify_id TEXT",
    "ALTER TABLE pedidos ADD COLUMN shopify_pago INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE pedidos ADD COLUMN reembolso_centavos INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE pedidos ADD COLUMN reembolsado_em TEXT",
    "ALTER TABLE pedidos ADD COLUMN link_id TEXT",
    "ALTER TABLE pedidos ADD COLUMN sessao TEXT",
    "ALTER TABLE pedidos ADD COLUMN desconto_centavos INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE pedidos ADD COLUMN cupom TEXT",
    "ALTER TABLE abandonos ADD COLUMN via_link INTEGER NOT NULL DEFAULT 0",
  ]) { try { db.exec(sql); } catch { /* já existe */ } }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pedidos_payment ON pedidos(payment_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_status  ON pedidos(status, criado_em);
    CREATE INDEX IF NOT EXISTS idx_pedidos_loja    ON pedidos(loja_id, criado_em);
    CREATE INDEX IF NOT EXISTS idx_eventos_pedido  ON eventos(pedido_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_aband_sessao ON abandonos(loja_id, sessao);
    CREATE INDEX IF NOT EXISTS idx_aband_loja ON abandonos(loja_id, criado_em);
    CREATE INDEX IF NOT EXISTS idx_links_loja ON links(loja_id, criado_em);
  `);

  const agora = () => new Date().toISOString();
  const pedidoDeLinha = (r) => r && {
    id: r.id, lojaId: r.loja_id, status: r.status, metodo: r.metodo, parcelas: r.parcelas,
    totalCentavos: r.total_centavos, freteCentavos: r.frete_centavos, paymentId: r.payment_id,
    cliente: JSON.parse(r.cliente), endereco: r.endereco ? JSON.parse(r.endereco) : null, itens: JSON.parse(r.itens),
    enviarParaShopify: !!r.enviar_shopify, shopifyPedido: r.shopify_pedido, shopifyId: r.shopify_id, shopifyPago: !!r.shopify_pago, erroShopify: r.shopify_erro,
    reembolsoCentavos: r.reembolso_centavos || 0, descontoCentavos: r.desconto_centavos || 0, cupom: r.cupom, reembolsadoEm: r.reembolsado_em, linkId: r.link_id,
    criadoEm: r.criado_em, atualizadoEm: r.atualizado_em,
  };
  const abDeLinha = (r) => r && {
    id: r.id, lojaId: r.loja_id, sessao: r.sessao, cliente: JSON.parse(r.cliente), carrinho: JSON.parse(r.carrinho),
    totalCentavos: r.total_centavos, status: r.status, pedidoId: r.pedido_id, contatadoEm: r.contatado_em, criadoEm: r.criado_em, atualizadoEm: r.atualizado_em,
  };
  const linkDeLinha = (r) => r && {
    id: r.id, lojaId: r.loja_id, titulo: r.titulo, descricao: r.descricao, valorCentavos: r.valor_centavos,
    pedirEndereco: !!r.pedir_endereco, ativo: !!r.ativo, criadoEm: r.criado_em,
  };
  const lojaDeLinha = (r) => r && { id: r.id, usuarioId: r.usuario_id, slug: r.slug, nome: r.nome, config: JSON.parse(r.config), atualizadoEm: r.atualizado_em, criadoEm: r.criado_em };
  const faturaDeLinha = (r) => r && { id: r.id, lojaId: r.loja_id, plano: r.plano, inicio: r.inicio, fim: r.fim, vendasCentavos: r.vendas_centavos, pedidos: r.pedidos,
    comissaoPct: r.comissao_pct, mensalidadeCentavos: r.mensalidade_centavos, comissaoCentavos: r.comissao_centavos, totalCentavos: r.total_centavos,
    status: r.status, venceEm: r.vence_em, pagoEm: r.pago_em, metodo: r.metodo, pagamentoId: r.pagamento_id, tentativas: r.tentativas,
    ultimaTentativa: r.ultima_tentativa, obs: r.obs, criadoEm: r.criado_em, loja: r.loja_nome, slug: r.slug };

  const q = (sql) => db.prepare(sql);
  const st = {
    // contas
    novoUsuario: q(`INSERT INTO usuarios (id,email,nome,senha_hash,criado_em) VALUES (?,?,?,?,?)`),
    usuarioPorEmail: q(`SELECT * FROM usuarios WHERE email=?`),
    usuarioPorId: q(`SELECT id,email,nome,criado_em FROM usuarios WHERE id=?`),
    novaSessao: q(`INSERT INTO sessoes (token_hash,usuario_id,expira_em) VALUES (?,?,?)`),
    sessao: q(`SELECT * FROM sessoes WHERE token_hash=? AND expira_em > ?`),
    apagarSessao: q(`DELETE FROM sessoes WHERE token_hash=?`),
    limparSessoes: q(`DELETE FROM sessoes WHERE expira_em <= ?`),
    // lojas
    novaLoja: q(`INSERT INTO lojas (id,usuario_id,slug,nome,config,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?)`),
    lojaPorUsuario: q(`SELECT * FROM lojas WHERE usuario_id=?`),
    lojaPorSlug: q(`SELECT * FROM lojas WHERE slug=?`),
    lojaPorId: q(`SELECT * FROM lojas WHERE id=?`),
    salvarLoja: q(`UPDATE lojas SET nome=?, config=?, atualizado_em=? WHERE id=?`),
    // pedidos
    inserir: q(`INSERT INTO pedidos (id,loja_id,status,metodo,parcelas,total_centavos,frete_centavos,payment_id,cliente,endereco,itens,enviar_shopify,criado_em,atualizado_em,link_id,sessao,desconto_centavos,cupom)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    pagoNaSessao: q(`SELECT 1 FROM pedidos WHERE loja_id=? AND sessao=? AND status='pago' LIMIT 1`),
    reembolso: q(`UPDATE pedidos SET reembolso_centavos=reembolso_centavos+?, reembolsado_em=?, status=CASE WHEN reembolso_centavos+? >= total_centavos THEN 'reembolsado' ELSE status END, atualizado_em=? WHERE id=?`),
    reembolsados: q(`SELECT * FROM pedidos WHERE loja_id=? AND reembolso_centavos>0 ORDER BY reembolsado_em DESC LIMIT 200`),
    // abandonos
    abUpsert: q(`INSERT INTO abandonos (id,loja_id,sessao,cliente,carrinho,total_centavos,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?,?)
                 ON CONFLICT(loja_id,sessao) DO UPDATE SET cliente=excluded.cliente, carrinho=excluded.carrinho, total_centavos=excluded.total_centavos, atualizado_em=excluded.atualizado_em
                 WHERE abandonos.status='aberto'`),
    abPorSessao: q(`SELECT * FROM abandonos WHERE loja_id=? AND sessao=?`),
    abPorId: q(`SELECT * FROM abandonos WHERE id=?`),
    abPedido: q(`UPDATE abandonos SET pedido_id=?, via_link=MAX(via_link,?), atualizado_em=? WHERE loja_id=? AND sessao=?`),
    abPorPedido: q(`SELECT * FROM abandonos WHERE pedido_id=?`),
    abRecuperar: q(`UPDATE abandonos SET status='recuperado', atualizado_em=? WHERE id=?`),
    abApagar: q(`DELETE FROM abandonos WHERE id=?`),
    abContatado: q(`UPDATE abandonos SET contatado_em=? WHERE id=? AND loja_id=?`),
    abListar: q(`SELECT a.*, p.status pedido_status, p.metodo pedido_metodo FROM abandonos a LEFT JOIN pedidos p ON p.id=a.pedido_id
                 WHERE a.loja_id=? AND a.criado_em > ? ORDER BY a.atualizado_em DESC LIMIT 300`),
    // links
    linkNovo: q(`INSERT INTO links (id,loja_id,titulo,descricao,valor_centavos,pedir_endereco,ativo,criado_em) VALUES (?,?,?,?,?,?,1,?)`),
    linkPorId: q(`SELECT * FROM links WHERE id=?`),
    linkAtivo: q(`UPDATE links SET ativo=? WHERE id=? AND loja_id=?`),
    linksLoja: q(`SELECT l.*, (SELECT COUNT(*) FROM pedidos p WHERE p.link_id=l.id AND p.status='pago') vendas,
                  (SELECT COALESCE(SUM(total_centavos),0) FROM pedidos p WHERE p.link_id=l.id AND p.status='pago') receita
                  FROM links l WHERE loja_id=? ORDER BY criado_em DESC`),
    payment: q(`UPDATE pedidos SET payment_id=?, atualizado_em=? WHERE id=?`),
    status: q(`UPDATE pedidos SET status=?, atualizado_em=? WHERE id=? AND status<>'pago'`),
    marcarPago: q(`UPDATE pedidos SET status='pago', atualizado_em=? WHERE id=? AND status<>'pago'`),
    shopifyOk: q(`UPDATE pedidos SET shopify_pedido=?, shopify_id=?, shopify_pago=?, shopify_erro=NULL, atualizado_em=? WHERE id=?`),
    shopifyErro: q(`UPDATE pedidos SET shopify_erro=?, atualizado_em=? WHERE id=?`),
    porId: q(`SELECT * FROM pedidos WHERE id=?`),
    porPayment: q(`SELECT * FROM pedidos WHERE payment_id=?`),
    pendentes: q(`SELECT * FROM pedidos WHERE status='pendente' AND payment_id IS NOT NULL AND criado_em > ? ORDER BY criado_em`),
    errosShopify: q(`SELECT * FROM pedidos WHERE status='pago' AND enviar_shopify=1 AND shopify_pago=0 ORDER BY criado_em LIMIT 200`),
    listarLoja: q(`SELECT * FROM pedidos WHERE loja_id=? ORDER BY criado_em DESC LIMIT ?`),
    resumoLoja: q(`SELECT COUNT(*) n, SUM(CASE WHEN status='pago' THEN 1 ELSE 0 END) pagos,
                   COALESCE(SUM(CASE WHEN status='pago' THEN total_centavos END),0) receita FROM pedidos WHERE loja_id=? AND criado_em > ?`),
    serie: q(`SELECT substr(criado_em,1,10) dia, COUNT(*) pedidos,
              COALESCE(SUM(CASE WHEN status='pago' THEN total_centavos END),0) receita,
              SUM(CASE WHEN status='pago' THEN 1 ELSE 0 END) pagos
              FROM pedidos WHERE loja_id=? AND criado_em > ? GROUP BY dia ORDER BY dia`),
    pagosDesde: q(`SELECT itens FROM pedidos WHERE loja_id=? AND status='pago' AND criado_em > ?`),
    // faturamento líquido: pagos (inclusive parcialmente reembolsados) menos reembolsos
    receitaTotal: q(`SELECT COALESCE(SUM(total_centavos - reembolso_centavos),0) total FROM pedidos WHERE loja_id=? AND status='pago'`),
    // faturas (cobrança da plataforma)
    baseComissao: q(`SELECT COUNT(*) n, COALESCE(SUM(total_centavos - reembolso_centavos),0) v FROM pedidos
                     WHERE loja_id=? AND status IN ('pago','reembolsado') AND criado_em >= ? AND criado_em < ?`),
    novaFatura: q(`INSERT OR IGNORE INTO faturas (id,loja_id,plano,inicio,fim,vendas_centavos,pedidos,comissao_pct,mensalidade_centavos,comissao_centavos,total_centavos,status,vence_em,criado_em)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    faturasDaLoja: q(`SELECT * FROM faturas WHERE loja_id=? ORDER BY inicio DESC LIMIT 60`),
    fatura: q(`SELECT * FROM faturas WHERE id=?`),
    faturaPorPagamento: q(`SELECT * FROM faturas WHERE pagamento_id=?`),
    faturasAbertas: q(`SELECT * FROM faturas WHERE status='aberta' ORDER BY vence_em`),
    faturasAdmin: q(`SELECT f.*, l.nome loja_nome, l.slug FROM faturas f JOIN lojas l ON l.id=f.loja_id ORDER BY f.criado_em DESC LIMIT 300`),
    faturaPaga: q(`UPDATE faturas SET status='paga', pago_em=?, metodo=?, pagamento_id=COALESCE(?, pagamento_id) WHERE id=? AND status='aberta'`),
    faturaStatus: q(`UPDATE faturas SET status=?, obs=? WHERE id=?`),
    faturaPagamento: q(`UPDATE faturas SET pagamento_id=?, metodo=? WHERE id=?`),
    faturaTentativa: q(`UPDATE faturas SET tentativas=tentativas+1, ultima_tentativa=?, obs=? WHERE id=?`),
    todasLojas: q(`SELECT * FROM lojas`),
    emailReservar: q(`INSERT OR IGNORE INTO emails (id,loja_id,evento,chave,para,assunto,status,criado_em) VALUES (?,?,?,?,?,?,'enviando',?)`),
    emailFim: q(`UPDATE emails SET status=?, erro=?, provedor_id=? WHERE id=?`),
    emailsDaLoja: q(`SELECT * FROM emails WHERE loja_id=? ORDER BY criado_em DESC LIMIT 60`),
    abParaEmail: q(`SELECT a.* FROM abandonos a WHERE a.status='aberto' AND a.pedido_id IS NULL AND a.atualizado_em <= ? AND a.atualizado_em >= ?
                    AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.evento='carrinho_abandonado' AND e.chave=a.id) LIMIT 200`),
    platGet: q(`SELECT valor FROM plataforma WHERE chave=?`),
    platSet: q(`INSERT INTO plataforma (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor`),
    conqNova: q(`INSERT OR IGNORE INTO conquistas (loja_id,nivel,meta_centavos,atingido_em) VALUES (?,?,?,?)`),
    conqLoja: q(`SELECT nivel, meta_centavos, atingido_em, entregue_em FROM conquistas WHERE loja_id=? ORDER BY nivel`),
    conqTodas: q(`SELECT c.*, l.nome loja_nome, l.slug, u.email FROM conquistas c JOIN lojas l ON l.id=c.loja_id JOIN usuarios u ON u.id=l.usuario_id ORDER BY c.atingido_em DESC LIMIT 300`),
    conqEntregue: q(`UPDATE conquistas SET entregue_em=? WHERE loja_id=? AND nivel=?`),
    adminLojas: q(`SELECT l.id, l.slug, l.nome, l.config, l.criado_em, u.email, u.nome dono,
                   (SELECT COUNT(*) FROM pedidos p WHERE p.loja_id=l.id AND p.criado_em > ?) pedidos,
                   (SELECT COALESCE(SUM(total_centavos),0) FROM pedidos p WHERE p.loja_id=l.id AND p.status='pago' AND p.criado_em > ?) receita,
                   (SELECT MAX(criado_em) FROM pedidos p WHERE p.loja_id=l.id) ultimo
                   FROM lojas l JOIN usuarios u ON u.id=l.usuario_id ORDER BY l.criado_em DESC`),
    adminResumo: q(`SELECT (SELECT COUNT(*) FROM lojas) lojas, (SELECT COUNT(*) FROM usuarios) usuarios,
                   (SELECT COUNT(*) FROM pedidos WHERE criado_em > ?) pedidos,
                   (SELECT COUNT(*) FROM pedidos WHERE status='pago' AND criado_em > ?) pagos,
                   (SELECT COALESCE(SUM(total_centavos),0) FROM pedidos WHERE status='pago' AND criado_em > ?) receita,
                   (SELECT COUNT(*) FROM pedidos WHERE status='pago' AND enviar_shopify=1 AND shopify_pago=0) errosShopify`),
    adminPedidos: q(`SELECT p.*, l.nome loja_nome FROM pedidos p LEFT JOIN lojas l ON l.id=p.loja_id ORDER BY p.criado_em DESC LIMIT ?`),
    evento: q(`INSERT INTO eventos (pedido_id,tipo,detalhe,criado_em) VALUES (?,?,?,?)`),
    eventos: q(`SELECT tipo,detalhe,criado_em FROM eventos WHERE pedido_id=? ORDER BY id`),
  };

  return {
    // ---- contas e sessões ----
    criarUsuario(u) { st.novoUsuario.run(u.id, u.email, u.nome, u.senhaHash, agora()); },
    usuarioPorEmail: (e) => st.usuarioPorEmail.get(e),
    usuarioPorId: (id) => st.usuarioPorId.get(id),
    criarSessao(tokenHash, usuarioId, dias = 30) {
      st.limparSessoes.run(agora());
      st.novaSessao.run(tokenHash, usuarioId, new Date(Date.now() + dias * 864e5).toISOString());
    },
    sessao: (tokenHash) => st.sessao.get(tokenHash, agora()),
    apagarSessao: (tokenHash) => st.apagarSessao.run(tokenHash),

    // ---- lojas ----
    criarLoja(l) { const t = agora(); st.novaLoja.run(l.id, l.usuarioId, l.slug, l.nome, JSON.stringify(l.config), t, t); },
    lojaPorUsuario: (id) => lojaDeLinha(st.lojaPorUsuario.get(id)),
    lojaPorSlug: (s) => lojaDeLinha(st.lojaPorSlug.get(s)),
    lojaPorId: (id) => lojaDeLinha(st.lojaPorId.get(id)),
    salvarLoja(id, nome, config) { st.salvarLoja.run(nome, JSON.stringify(config), agora(), id); },

    // ---- pedidos ----
    criar(p) {
      st.inserir.run(p.id, p.lojaId || null, p.status, p.metodo, p.parcelas, p.totalCentavos, p.freteCentavos || 0, p.paymentId || null,
        JSON.stringify(p.cliente), p.endereco ? JSON.stringify(p.endereco) : null, JSON.stringify(p.itens),
        p.enviarParaShopify ? 1 : 0, p.criadoEm, agora(), p.linkId || null, p.sessao || null, p.descontoCentavos || 0, p.cupom || null);
      this.evento(p.id, "criado", `${p.metodo} ${p.totalCentavos}`);
    },
    definirPayment(id, paymentId) { st.payment.run(paymentId, agora(), id); },
    definirStatus(id, status) { st.status.run(status, agora(), id); },
    /** true só para quem efetivamente mudou o pedido para "pago" (evita duplicar na Shopify) */
    marcarPago(id) { return st.marcarPago.run(agora(), id).changes === 1; },
    shopifyOk(id, nome, gid, pago) { st.shopifyOk.run(nome, gid || null, pago ? 1 : 0, agora(), id); this.evento(id, pago ? "shopify_pago" : "shopify_pendente", nome); },
    shopifyErro(id, msg) { st.shopifyErro.run(msg, agora(), id); this.evento(id, "shopify_erro", msg); },
    buscar: (id) => pedidoDeLinha(st.porId.get(id)),
    buscarPorPayment: (pid) => pedidoDeLinha(st.porPayment.get(pid)),
    pendentesDesde: (iso) => st.pendentes.all(iso).map(pedidoDeLinha),
    comErroShopify: () => st.errosShopify.all().map(pedidoDeLinha),
    listarDaLoja: (lojaId, limite = 100) => st.listarLoja.all(lojaId, limite).map(pedidoDeLinha),
    resumoDaLoja: (lojaId, desdeIso) => st.resumoLoja.get(lojaId, desdeIso),
    serieDaLoja: (lojaId, desdeIso) => st.serie.all(lojaId, desdeIso),
    receitaTotalDaLoja: (lojaId) => st.receitaTotal.get(lojaId).total,
    // vendas por variante (pedidos pagos no período)
    vendasPorVariante(lojaId, desdeIso) {
      const m = {};
      for (const r of st.pagosDesde.all(lojaId, desdeIso))
        for (const i of JSON.parse(r.itens)) {
          const v = (m[i.variantId] ||= { quantidade: 0, receita: 0 });
          v.quantidade += i.quantidade; v.receita += i.precoCentavos * i.quantidade;
        }
      return m;
    },
    evento(id, tipo, detalhe = null) { st.evento.run(id, tipo, detalhe == null ? null : String(detalhe).slice(0, 2000), agora()); },
    eventos: (id) => st.eventos.all(id),
    // ---- admin da plataforma ----
    adminLojas: (desde) => st.adminLojas.all(desde, desde).map((r) => ({ ...r, config: JSON.parse(r.config) })),
    adminResumo: (desde) => st.adminResumo.get(desde, desde, desde),
    adminPedidos: (limite = 200) => st.adminPedidos.all(limite).map((r) => ({ ...pedidoDeLinha(r), lojaNome: r.loja_nome })),
    // ---- reembolsos ----
    registrarReembolso(id, valor) { const t = agora(); st.reembolso.run(valor, t, valor, t, id); this.evento(id, "reembolso", `${valor}`); },
    reembolsadosDaLoja: (lojaId) => st.reembolsados.all(lojaId).map(pedidoDeLinha),

    // ---- checkout abandonado ----
    salvarAbandono(a) {
      if (st.pagoNaSessao.get(a.lojaId, a.sessao)) return null; // já comprou nesta sessão: não é abandono
      st.abUpsert.run(a.id, a.lojaId, a.sessao, JSON.stringify(a.cliente), JSON.stringify(a.carrinho), a.totalCentavos || 0, agora(), agora());
      return abDeLinha(st.abPorSessao.get(a.lojaId, a.sessao));
    },
    abandonoPorId: (id) => abDeLinha(st.abPorId.get(id)),
    vincularAbandono(lojaId, sessao, pedidoId, viaLink) { if (lojaId && sessao) st.abPedido.run(pedidoId, viaLink ? 1 : 0, agora(), lojaId, sessao); },
    // Pedido pago: conta como recuperado só se o cliente voltou pelo link de recuperação, foi contatado
    // ou pagou mais de 1 hora depois de abandonar. Senão foi uma compra normal e o registro é apagado.
    fecharAbandono(pedidoId) {
      const r = st.abPorPedido.get(pedidoId);
      if (!r) return;
      const recuperado = r.via_link || r.contatado_em || Date.now() - new Date(r.criado_em).getTime() > 3600e3;
      if (recuperado) st.abRecuperar.run(agora(), r.id); else st.abApagar.run(r.id);
    },
    marcarContatado(id, lojaId, sim) { st.abContatado.run(sim ? agora() : null, id, lojaId); },
    abandonosDaLoja: (lojaId, desde) => st.abListar.all(lojaId, desde).map((r) => ({ ...abDeLinha(r), pedidoStatus: r.pedido_status, pedidoMetodo: r.pedido_metodo })),

    // ---- links de pagamento ----
    criarLink(l) { st.linkNovo.run(l.id, l.lojaId, l.titulo, l.descricao || null, l.valorCentavos, l.pedirEndereco ? 1 : 0, agora()); },
    linkPorId: (id) => linkDeLinha(st.linkPorId.get(id)),
    ativarLink(id, lojaId, ativo) { st.linkAtivo.run(ativo ? 1 : 0, id, lojaId); },
    linksDaLoja: (lojaId) => st.linksLoja.all(lojaId).map((r) => ({ ...linkDeLinha(r), vendas: r.vendas, receita: r.receita })),

    // ---- faturas ----
    baseComissao: (lojaId, de, ate) => st.baseComissao.get(lojaId, de, ate),
    criarFatura(f) {
      return st.novaFatura.run(f.id, f.lojaId, f.plano, f.inicio, f.fim, f.vendasCentavos, f.pedidos, f.comissaoPct, f.mensalidadeCentavos,
        f.comissaoCentavos, f.totalCentavos, f.status, f.venceEm, agora()).changes > 0;
    },
    faturasDaLoja: (lojaId) => st.faturasDaLoja.all(lojaId).map(faturaDeLinha),
    fatura: (id) => faturaDeLinha(st.fatura.get(id)),
    faturaPorPagamento: (pid) => faturaDeLinha(st.faturaPorPagamento.get(pid)),
    faturasAbertas: () => st.faturasAbertas.all().map(faturaDeLinha),
    faturasAdmin: () => st.faturasAdmin.all().map(faturaDeLinha),
    /** true só para quem efetivamente marcou como paga */
    pagarFatura: (id, metodo, pagamentoId) => st.faturaPaga.run(agora(), metodo, pagamentoId || null, id).changes > 0,
    statusFatura: (id, status, obs) => st.faturaStatus.run(status, obs || null, id),
    pagamentoFatura: (id, pid, metodo) => st.faturaPagamento.run(pid, metodo, id),
    tentativaFatura: (id, obs) => st.faturaTentativa.run(agora(), obs || null, id),
    todasLojas: () => st.todasLojas.all().map(lojaDeLinha),
    /** reserva o envio (evento+chave únicos); devolve false se já foi enviado */
    reservarEmail: (e) => st.emailReservar.run(e.id, e.lojaId, e.evento, e.chave, e.para, e.assunto, agora()).changes > 0,
    concluirEmail: (id, status, erro, provedorId) => st.emailFim.run(status, erro || null, provedorId || null, id),
    emailsDaLoja: (lojaId) => st.emailsDaLoja.all(lojaId).map((r) => ({ id: r.id, evento: r.evento, para: r.para, assunto: r.assunto, status: r.status, erro: r.erro, criadoEm: r.criado_em })),
    abandonosParaEmail: (ate, desde) => st.abParaEmail.all(ate, desde).map(abDeLinha),

    // ---- plataforma (configurações globais) e recompensas ----
    lerPlataforma(chave, padrao) { const r = st.platGet.get(chave); return r ? JSON.parse(r.valor) : padrao; },
    gravarPlataforma(chave, valor) { st.platSet.run(chave, JSON.stringify(valor)); },
    registrarConquista(lojaId, nivel, meta) { return st.conqNova.run(lojaId, nivel, meta, agora()).changes === 1; },
    conquistasDaLoja: (lojaId) => st.conqLoja.all(lojaId).map((r) => ({ nivel: r.nivel, metaCentavos: r.meta_centavos, atingidoEm: r.atingido_em, entregueEm: r.entregue_em })),
    todasConquistas: () => st.conqTodas.all().map((r) => ({ lojaId: r.loja_id, loja: r.loja_nome, slug: r.slug, email: r.email, nivel: r.nivel, metaCentavos: r.meta_centavos, atingidoEm: r.atingido_em, entregueEm: r.entregue_em })),
    marcarEntregue(lojaId, nivel, sim) { st.conqEntregue.run(sim ? agora() : null, lojaId, nivel); },
    fechar: () => db.close(),
  };
}

module.exports = { abrirBanco };
