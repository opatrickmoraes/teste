// Cliente mínimo da Shopify Admin API (GraphQL) — sem dependências.
// Precisa de um app personalizado com os escopos: read_products, write_orders.

function criarShopify({ loja, token, versao = "2025-10" }) {
  const endpoint = `https://${loja}/admin/api/${versao}/graphql.json`;

  async function gql(query, variables) {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok || dados.errors) throw new Error(`Shopify ${r.status}: ${JSON.stringify(dados.errors || dados)}`);
    return dados.data;
  }

  return {
    // itens: [{ variantId: "123", quantidade: 2 }] → itens com nome, imagem e preço vindos da Shopify
    async buscarItens(itens) {
      const ids = itens.map((i) => `gid://shopify/ProductVariant/${i.variantId}`);
      const data = await gql(
        `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant {
            id title price availableForSale
            image { url } product { title featuredImage { url } } } } }`,
        { ids }
      );
      return itens.map((item, n) => {
        const v = data.nodes[n];
        if (!v) throw Object.assign(new Error("Produto do carrinho não encontrado na loja"), { status: 400 });
        if (!v.availableForSale) throw Object.assign(new Error(`${v.product.title} está esgotado`), { status: 400 });
        return {
          variantId: item.variantId,
          gid: v.id,
          nome: v.product.title + (v.title && v.title !== "Default Title" ? ` — ${v.title}` : ""),
          imagem: (v.image || v.product.featuredImage || {}).url || null,
          quantidade: item.quantidade,
          precoCentavos: Math.round(parseFloat(v.price) * 100),
        };
      });
    },

    // Cria o pedido já pago na Shopify, com a transação da Cielo registrada
    async criarPedido(pedido) {
      const reais = (c) => (c / 100).toFixed(2);
      const [primeiro, ...resto] = pedido.cliente.nome.trim().split(/\s+/);
      const e = pedido.endereco;
      const data = await gql(
        `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput){
           orderCreate(order:$order, options:$options){ order { id name } userErrors { field message } } }`,
        {
          order: {
            email: pedido.cliente.email,
            lineItems: pedido.itens.map((i) => ({ variantId: i.gid, quantity: i.quantidade })),
            shippingAddress: {
              firstName: primeiro, lastName: resto.join(" ") || primeiro,
              address1: `${e.rua}, ${e.numero}`, address2: [e.complemento, e.bairro].filter(Boolean).join(" - "),
              city: e.cidade, provinceCode: e.uf, zip: e.cep, countryCode: "BR", phone: pedido.cliente.telefone || null,
            },
            shippingLines: pedido.freteCentavos > 0
              ? [{ title: "Frete", priceSet: { shopMoney: { amount: reais(pedido.freteCentavos), currencyCode: "BRL" } } }]
              : [],
            financialStatus: "PAID",
            note: `Checkout transparente · ${pedido.id} · ${pedido.metodo}${pedido.parcelas > 1 ? ` ${pedido.parcelas}x` : ""} · Cielo ${pedido.paymentId}`,
            transactions: [{
              kind: "SALE", status: "SUCCESS", gateway: "Cielo",
              amountSet: { shopMoney: { amount: reais(pedido.totalCentavos), currencyCode: "BRL" } },
            }],
          },
          options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: true },
        }
      );
      const res = data.orderCreate;
      if (res.userErrors.length) throw new Error("Shopify orderCreate: " + res.userErrors.map((u) => u.message).join("; "));
      return res.order; // { id, name: "#1042" }
    },
  };
}

module.exports = { criarShopify };
