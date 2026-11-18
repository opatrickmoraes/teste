// Cliente mínimo da API E-commerce Cielo 3.0 + Silent Order Post (SOP)
// Sem dependências: usa o fetch nativo do Node 18+.

const AMBIENTES = {
  sandbox: {
    api: "https://apisandbox.cieloecommerce.cielo.com.br",
    query: "https://apiquerysandbox.cieloecommerce.cielo.com.br",
    oauth: "https://authsandbox.braspag.com.br/oauth2/token",
    sop: "https://transactionsandbox.pagador.com.br/post/api/public/v2/accesstoken",
    sopScript: "https://transactionsandbox.pagador.com.br/post/scripts/silentorderpost-1.0.min.js",
  },
  production: {
    api: "https://api.cieloecommerce.cielo.com.br",
    query: "https://apiquery.cieloecommerce.cielo.com.br",
    oauth: "https://auth.braspag.com.br/oauth2/token",
    sop: "https://transaction.pagador.com.br/post/api/public/v2/accesstoken",
    sopScript: "https://transaction.pagador.com.br/post/scripts/silentorderpost-1.0.min.js",
  },
};

function criarCielo(cfg) {
  const url = AMBIENTES[cfg.ambiente] || AMBIENTES.sandbox;
  const headers = {
    "Content-Type": "application/json",
    MerchantId: cfg.merchantId,
    MerchantKey: cfg.merchantKey,
  };

  async function chamar(metodo, endpoint, corpo) {
    const r = await fetch(endpoint, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const texto = await r.text();
    const dados = texto ? JSON.parse(texto) : {};
    if (!r.ok) {
      const msg = Array.isArray(dados) ? dados.map((e) => `${e.Code}: ${e.Message}`).join("; ") : texto;
      throw new Error(`Cielo ${r.status} - ${msg}`);
    }
    return dados;
  }

  return {
    sopScript: url.sopScript,

    // 1) OAuth com ClientId/ClientSecret  2) AccessToken do SOP (vale poucos minutos)
    async gerarAccessTokenSOP() {
      const basic = Buffer.from(`${cfg.sopClientId}:${cfg.sopClientSecret}`).toString("base64");
      const o = await fetch(url.oauth, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      if (!o.ok) throw new Error(`OAuth SOP falhou: ${o.status} ${await o.text()}`);
      const { access_token } = await o.json();

      const t = await fetch(url.sop, {
        method: "POST",
        headers: { MerchantId: cfg.merchantId, Authorization: `Bearer ${access_token}` },
      });
      if (!t.ok) throw new Error(`AccessToken SOP falhou: ${t.status} ${await t.text()}`);
      return (await t.json()).AccessToken;
    },

    // Cartão de crédito usando o PaymentToken gerado pelo SOP no navegador
    venderCartao({ pedidoId, cliente, valorCentavos, parcelas, paymentToken, bandeira, softDescriptor }) {
      return chamar("POST", `${url.api}/1/sales`, {
        MerchantOrderId: pedidoId,
        Customer: { Name: cliente.nome, Email: cliente.email, Identity: cliente.cpf, IdentityType: "CPF" },
        Payment: {
          Type: "CreditCard",
          Amount: valorCentavos,
          Installments: parcelas,
          Capture: true,
          SoftDescriptor: softDescriptor,
          CreditCard: { PaymentToken: paymentToken, Brand: bandeira },
        },
      });
    },

    venderPix({ pedidoId, cliente, valorCentavos }) {
      return chamar("POST", `${url.api}/1/sales`, {
        MerchantOrderId: pedidoId,
        Customer: { Name: cliente.nome, Identity: cliente.cpf, IdentityType: "CPF" },
        Payment: { Type: "Pix", Amount: valorCentavos },
      });
    },

    consultar(paymentId) {
      return chamar("GET", `${url.query}/1/sales/${paymentId}`);
    },
  };
}

// Status da Cielo → status do seu pedido
// 1 Autorizado | 2 Pago | 3 Negado | 10 Cancelado | 11 Estornado | 12 Pendente | 13 Abortado
function traduzirStatus(s) {
  if (s === 2) return "pago";
  if (s === 1) return "autorizado";
  if (s === 12 || s === 0) return "pendente";
  return "recusado";
}

module.exports = { criarCielo, traduzirStatus };
