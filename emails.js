// E-mails transacionais: modelos padrão, montagem do HTML e envio pela API do Resend.
// Sem chave configurada, nada é enviado: o e-mail fica registrado como "simulado".

const EVENTOS = {
  pedido_aprovado: {
    nome: "Pedido aprovado", para: "cliente", descricao: "Quando o pagamento é aprovado (cartão ou Pix pago).",
    assunto: "Pedido {{pedido}} confirmado ✅",
    corpo: `Olá, {{primeiro_nome}}!

Recebemos o pagamento do seu pedido {{pedido}} na {{loja}}.

{{itens}}

Total: {{total}}
Pagamento: {{pagamento}}
{{entrega}}

Qualquer dúvida, é só responder este e-mail.

Obrigado pela compra!`,
  },
  pix_gerado: {
    nome: "Pix gerado", para: "cliente", descricao: "Logo depois que o cliente gera o Pix, com o código copia e cola.",
    assunto: "Seu Pix do pedido {{pedido}} está pronto",
    corpo: `Olá, {{primeiro_nome}}!

Seu pedido {{pedido}} na {{loja}} está aguardando o pagamento de {{total}}.

Para pagar, abra o app do seu banco, escolha Pix copia e cola e cole o código abaixo:

{{pix_copia_cola}}

{{pix_validade}}

Assim que o pagamento cair, você recebe a confirmação por aqui.`,
  },
  carrinho_abandonado: {
    nome: "Carrinho abandonado", para: "cliente", descricao: "Quando o cliente preenche o contato e não finaliza a compra.", atraso: true,
    assunto: "{{primeiro_nome}}, seu carrinho ainda está te esperando",
    corpo: `Olá, {{primeiro_nome}}!

Vimos que você começou uma compra na {{loja}} e não finalizou:

{{itens}}

Total: {{total}}

Guardamos tudo para você. É só clicar no botão para continuar de onde parou.

[Finalizar minha compra]({{link_checkout}})`,
  },
  reembolso: {
    nome: "Reembolso", para: "cliente", descricao: "Quando um reembolso é feito pelo painel.",
    assunto: "Reembolso do pedido {{pedido}}",
    corpo: `Olá, {{primeiro_nome}}!

Fizemos o reembolso de {{valor_reembolso}} do seu pedido {{pedido}} na {{loja}}.

No cartão de crédito, o valor aparece em até duas faturas, conforme o seu banco. No Pix, volta para a conta de onde saiu o pagamento.

Qualquer dúvida, é só responder este e-mail.`,
  },
  nova_venda: {
    nome: "Nova venda (para você)", para: "lojista", descricao: "Aviso para o seu e-mail a cada venda aprovada.",
    assunto: "💰 Nova venda de {{total}} · {{pedido}}",
    corpo: `Nova venda aprovada na {{loja}}!

Pedido: {{pedido}}
Cliente: {{cliente}} · {{email_cliente}}
Pagamento: {{pagamento}}

{{itens}}

Total: {{total}}
{{entrega}}`,
  },
};

const VARIAVEIS = {
  primeiro_nome: "Primeiro nome do cliente", cliente: "Nome completo do cliente", email_cliente: "E-mail do cliente",
  loja: "Nome da loja", pedido: "Número do pedido", total: "Total do pedido", itens: "Lista de produtos",
  pagamento: "Forma de pagamento", entrega: "Endereço e frete", pix_copia_cola: "Código Pix copia e cola",
  pix_validade: "Validade do Pix", link_checkout: "Link para voltar ao checkout (carrinho abandonado)", valor_reembolso: "Valor reembolsado",
};

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (c) => (Number(c || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Variáveis em texto e em HTML (itens viram tabela, Pix vira bloco destacado)
function variaveis(d) {
  const itensTxt = (d.itens || []).map((i) => `${i.quantidade}× ${i.nome} — ${brl(i.precoCentavos * i.quantidade)}`).join("\n");
  const itensHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0">${(d.itens || []).map((i) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px">${esc(i.quantidade)}× ${esc(i.nome)}</td><td align="right" style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;white-space:nowrap">${esc(brl(i.precoCentavos * i.quantidade))}</td></tr>`).join("")}</table>`;
  const e = d.endereco;
  const entrega = e ? `Entrega: ${e.rua}, ${e.numero}${e.complemento ? " - " + e.complemento : ""} · ${e.bairro} · ${e.cidade}/${e.uf} · ${e.cep}${e.frete ? `\nFrete: ${e.frete.nome}${e.frete.prazo ? " (" + e.frete.prazo + ")" : ""}` : ""}` : "";
  const nome = String(d.cliente?.nome || "").trim();
  const txt = {
    primeiro_nome: nome.split(/\s+/)[0] || "tudo bem", cliente: nome, email_cliente: d.cliente?.email || "", loja: d.loja || "",
    pedido: d.pedido || "", total: brl(d.totalCentavos), itens: itensTxt, pagamento: d.pagamento || "", entrega,
    pix_copia_cola: d.pix?.copiaECola || "", pix_validade: d.pix?.expiraEm ? `O código vale até ${new Date(d.pix.expiraEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}.` : "",
    link_checkout: d.linkCheckout || "", valor_reembolso: brl(d.valorReembolsoCentavos),
  };
  const html = Object.fromEntries(Object.entries(txt).map(([k, v]) => [k, esc(v).replace(/\n/g, "<br>")]));
  html.itens = itensHtml;
  html.pix_copia_cola = txt.pix_copia_cola ? `<div style="background:#f4f5f7;border:1px dashed #c7cbd4;border-radius:10px;padding:14px;font-family:monospace;font-size:13px;word-break:break-all">${esc(txt.pix_copia_cola)}</div>` : "";
  return { txt, html };
}
const trocar = (modelo, vars) => String(modelo || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));

// Monta assunto, texto e HTML. Linhas "[Texto](url)" viram botão.
function montar({ assunto, corpo }, dados, marca = {}) {
  const { txt, html } = variaveis(dados);
  const cor = /^#[0-9a-f]{6}$/i.test(marca.cor || "") ? marca.cor : "#111827";
  const assuntoFinal = trocar(assunto, txt).replace(/\s+/g, " ").trim().slice(0, 200);
  const texto = trocar(corpo, txt).replace(/^\[(.+?)\]\((.*?)\)$/gm, "$1: $2").replace(/\n{3,}/g, "\n\n").trim();
  const blocos = String(corpo || "").split(/\n{2,}/).map((bloco) => {
    const b = bloco.trim();
    const botao = b.match(/^\[(.+?)\]\((.*?)\)$/);
    if (botao) {
      const href = trocar(botao[2], txt);
      if (!/^https?:\/\//.test(href)) return "";
      return `<p style="margin:22px 0;text-align:center"><a href="${esc(href)}" style="background:${cor};color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block">${esc(trocar(botao[1], txt))}</a></p>`;
    }
    const conteudo = trocar(esc(b).replace(/\n/g, "<br>").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, "{{$1}}"), html).trim();
    if (!conteudo || conteudo === "<br>") return "";
    return /^<(table|div)/.test(conteudo) ? conteudo : `<p style="margin:0 0 14px;line-height:1.55;font-size:15px">${conteudo}</p>`;
  }).join("\n");
  const htmlFinal = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:${cor};color:#fff;padding:18px 26px;font-size:18px;font-weight:700">${esc(dados.loja || "")}</td></tr>
<tr><td style="padding:26px">${blocos}</td></tr>
<tr><td style="padding:14px 26px;border-top:1px solid #eee;color:#6b7280;font-size:12px">Você recebeu este e-mail por uma compra na ${esc(dados.loja || "loja")}.</td></tr>
</table></td></tr></table></body></html>`;
  return { assunto: assuntoFinal, texto, html: htmlFinal };
}

async function enviarResend({ apiKey, de, para, responderPara, assunto, html, texto }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: de, to: [para], subject: assunto, html, text: texto, ...(responderPara ? { reply_to: responderPara } : {}) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend (${r.status}): ${d.message || d.error || JSON.stringify(d).slice(0, 200)}`);
  return d.id || null;
}

// Dados fictícios para prévia e e-mail de teste
const EXEMPLO = {
  loja: "Minha Loja", pedido: "PED-EXEMPLO", totalCentavos: 21480, pagamento: "Cartão 3x",
  cliente: { nome: "Maria Souza", email: "maria@exemplo.com" },
  itens: [{ nome: "Moletom Oversized — M", quantidade: 1, precoCentavos: 19990 }],
  endereco: { rua: "Av. Paulista", numero: "1000", complemento: "", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP", cep: "01310-100", frete: { nome: "Motoboy", prazo: "No mesmo dia" } },
  pix: { copiaECola: "00020126580014br.gov.bcb.pix0136exemplo-de-codigo-pix5204000053039865802BR6304ABCD", expiraEm: new Date(Date.now() + 3600e3).toISOString() },
  linkCheckout: "https://exemplo.com/checkout", valorReembolsoCentavos: 21480,
};

module.exports = { EVENTOS, VARIAVEIS, montar, enviarResend, EXEMPLO };
