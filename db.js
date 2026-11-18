// Banco de dados SQLite embutido no Node 22+ (node:sqlite) — sem dependências.
// Tudo fica num arquivo (DB_ARQUIVO, padrão ./dados/checkout.db).
// Em hospedagem, esse arquivo precisa estar num disco/volume persistente.

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

    CREATE TABLE IF NOT EXISTS pedidos (
      id               TEXT PRIMARY KEY,
      status           TEXT NOT NULL,          -- criado | pendente | autorizado | pago | recusado
      metodo           TEXT NOT NULL,          -- cartao | pix
      parcelas         INTEGER NOT NULL DEFAULT 1,
      total_centavos   INTEGER NOT NULL,
      frete_centavos   INTEGER NOT NULL DEFAULT 0,
      payment_id       TEXT,
      cliente          TEXT NOT NULL,          -- JSON
      endereco         TEXT,                   -- JSON
      itens            TEXT NOT NULL,          -- JSON
      enviar_shopify   INTEGER NOT NULL DEFAULT 0,
      shopify_pedido   TEXT,                   -- ex.: "#1042"
      shopify_erro     TEXT,
      criado_em        TEXT NOT NULL,
      atualizado_em    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_payment ON pedidos(payment_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_status  ON pedidos(status, criado_em);

    CREATE TABLE IF NOT EXISTS eventos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id  TEXT NOT NULL,
      tipo       TEXT NOT NULL,
      detalhe    TEXT,
      criado_em  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventos_pedido ON eventos(pedido_id);
  `);

  const agora = () => new Date().toISOString();
  const deLinha = (r) => r && {
    id: r.id, status: r.status, metodo: r.metodo, parcelas: r.parcelas,
    totalCentavos: r.total_centavos, freteCentavos: r.frete_centavos, paymentId: r.payment_id,
    cliente: JSON.parse(r.cliente), endereco: r.endereco ? JSON.parse(r.endereco) : null, itens: JSON.parse(r.itens),
    enviarParaShopify: !!r.enviar_shopify, shopifyPedido: r.shopify_pedido, erroShopify: r.shopify_erro,
    criadoEm: r.criado_em, atualizadoEm: r.atualizado_em,
  };

  const st = {
    inserir: db.prepare(`INSERT INTO pedidos (id,status,metodo,parcelas,total_centavos,frete_centavos,payment_id,cliente,endereco,itens,enviar_shopify,criado_em,atualizado_em)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    payment: db.prepare(`UPDATE pedidos SET payment_id=?, atualizado_em=? WHERE id=?`),
    status: db.prepare(`UPDATE pedidos SET status=?, atualizado_em=? WHERE id=? AND status<>'pago'`),
    // Só um processo "ganha" a transição para pago — evita pedido duplicado na Shopify
    marcarPago: db.prepare(`UPDATE pedidos SET status='pago', atualizado_em=? WHERE id=? AND status<>'pago'`),
    shopifyOk: db.prepare(`UPDATE pedidos SET shopify_pedido=?, shopify_erro=NULL, atualizado_em=? WHERE id=?`),
    shopifyErro: db.prepare(`UPDATE pedidos SET shopify_erro=?, atualizado_em=? WHERE id=?`),
    porId: db.prepare(`SELECT * FROM pedidos WHERE id=?`),
    porPayment: db.prepare(`SELECT * FROM pedidos WHERE payment_id=?`),
    pendentes: db.prepare(`SELECT * FROM pedidos WHERE status='pendente' AND payment_id IS NOT NULL AND criado_em > ? ORDER BY criado_em`),
    errosShopify: db.prepare(`SELECT * FROM pedidos WHERE status='pago' AND enviar_shopify=1 AND shopify_pedido IS NULL ORDER BY criado_em`),
    listar: db.prepare(`SELECT * FROM pedidos ORDER BY criado_em DESC LIMIT ?`),
    evento: db.prepare(`INSERT INTO eventos (pedido_id,tipo,detalhe,criado_em) VALUES (?,?,?,?)`),
    eventos: db.prepare(`SELECT tipo,detalhe,criado_em FROM eventos WHERE pedido_id=? ORDER BY id`),
  };

  return {
    criar(p) {
      st.inserir.run(p.id, p.status, p.metodo, p.parcelas, p.totalCentavos, p.freteCentavos || 0, p.paymentId || null,
        JSON.stringify(p.cliente), p.endereco ? JSON.stringify(p.endereco) : null, JSON.stringify(p.itens),
        p.enviarParaShopify ? 1 : 0, p.criadoEm, agora());
      this.evento(p.id, "criado", `${p.metodo} ${p.totalCentavos}`);
    },
    definirPayment(id, paymentId) { st.payment.run(paymentId, agora(), id); },
    definirStatus(id, status) { st.status.run(status, agora(), id); },
    /** @returns {boolean} true só para quem efetivamente mudou o pedido para "pago" */
    marcarPago(id) { return st.marcarPago.run(agora(), id).changes === 1; },
    shopifyOk(id, nome) { st.shopifyOk.run(nome, agora(), id); this.evento(id, "shopify_ok", nome); },
    shopifyErro(id, msg) { st.shopifyErro.run(msg, agora(), id); this.evento(id, "shopify_erro", msg); },
    buscar: (id) => deLinha(st.porId.get(id)),
    buscarPorPayment: (pid) => deLinha(st.porPayment.get(pid)),
    pendentesDesde: (iso) => st.pendentes.all(iso).map(deLinha),
    comErroShopify: () => st.errosShopify.all().map(deLinha),
    listar: (limite = 50) => st.listar.all(limite).map(deLinha),
    evento(id, tipo, detalhe = null) { st.evento.run(id, tipo, detalhe == null ? null : String(detalhe).slice(0, 2000), agora()); },
    eventos: (id) => st.eventos.all(id),
    fechar: () => db.close(),
  };
}

module.exports = { abrirBanco };
