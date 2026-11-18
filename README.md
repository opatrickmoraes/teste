# Checkout transparente Cielo + Shopify

O cliente clica em "Finalizar compra" na sua loja Shopify, cai nesta página com a sua marca e paga no cartão (até 12x) ou no Pix pela Cielo. Quando o pagamento é aprovado, o pedido é criado na Shopify já como pago.

```
Loja Shopify ──(itens do carrinho)──► Checkout (este projeto) ──► Cielo
                                              │
                         pagamento aprovado ──┴──► pedido pago na Shopify
```

## 1. Testar no seu computador (5 min)

Precisa do Node.js 22.5 ou mais novo. Não há nada para instalar.

```bash
node server.js
```

- Site com o guia completo: http://localhost:3000/ (menu "Integração")
- Checkout com carrinho de teste: http://localhost:3000/checkout?itens=111:2,222:1
- Produto avulso: http://localhost:3000/checkout?produto=curso-pro

Sem credenciais, tudo roda em simulação. Cartões terminados em 0, 1 ou 4 são aprovados, e o Pix tem um botão "Simular pagamento".

## 2. Pegar as credenciais

**Cielo** (portal de desenvolvedores e suporte e-commerce):
- MerchantId e MerchantKey. Comece pelas de **sandbox**.
- Silent Order Post habilitado, com ClientId e ClientSecret. Peça ao suporte.
- Pix habilitado no cadastro.

**Shopify** (admin → Configurações → Apps → Desenvolver apps, ou Dev Dashboard):
- Crie um app personalizado com os escopos `read_products` e `write_orders`, e instale na loja.
- Copie o token da Admin API (`shpat_...`).

## 3. Colocar no ar (com HTTPS)

O jeito mais simples é uma hospedagem de Node que já dá HTTPS: **Render**, **Railway** ou **Fly.io**.

1. Suba esta pasta para um repositório no GitHub. **Não suba o arquivo `.env`.**
2. Na hospedagem, crie um "Web Service" a partir do repositório:
   - Comando de start: `node server.js`
   - Porta: a hospedagem define `PORT` sozinha.
3. Em "Environment variables", cadastre as mesmas variáveis do `.env.example`.
4. Aponte um subdomínio seu para o serviço, por exemplo `seudominio.com.br` (registro CNAME no seu DNS).
5. Abra `https://seudominio.com.br/saude`. A resposta deve mostrar o modo e a Shopify conectada.

Em uma VPS própria: rode com `pm2 start server.js` atrás de Nginx com certificado do Let's Encrypt.

### Banco de dados

Os pedidos ficam num banco **SQLite** (arquivo `dados/checkout.db`). Ele já vem no Node 22, então não precisa instalar nada.

- **Precisa de disco persistente.** No Railway, crie um *Volume* montado em `/data`. No Render, adicione um *Disk* (plano pago) em `/data`. Em uma VPS, o disco já é persistente. Depois defina `DB_ARQUIVO=/data/checkout.db`.
- Sem volume, o banco é apagado a cada novo deploy.
- Rode **uma instância só**: o SQLite é um arquivo local e não é compartilhado entre servidores.
- Backup: copie o arquivo `.db` periodicamente (ex.: `sqlite3 /data/checkout.db ".backup /data/backup.db"`).

Requer **Node 22.5 ou mais novo**. No painel da hospedagem, escolha Node 22.

## 4. Ligar a loja ao checkout

1. Na Shopify, vá em **Loja virtual → Temas → Duplicar** e edite a **cópia**.
2. Cole o conteúdo de `shopify-tema/checkout-externo.liquid` no fim do `layout/theme.liquid`, antes de `</body>`.
3. Troque `https://seudominio.com.br/checkout` pela URL do seu checkout.
4. Visualize o tema duplicado, adicione produtos ao carrinho e clique em finalizar. Você deve cair no seu checkout com os itens.
5. Se o tema tiver carrinho lateral e o botão não redirecionar, adicione `data-checkout-externo` no botão do tema.
6. Funcionou? Publique o tema.

## 5. Webhook da Cielo

Peça ao suporte e-commerce da Cielo para cadastrar a URL de notificação:

```
https://seudominio.com.br/webhook/cielo
```

Ela confirma o Pix. Se o webhook atrasar, a própria tela do Pix consulta a Cielo a cada 4 segundos.

## 6. Acompanhar os pedidos (admin)

Defina `ADMIN_TOKEN` e use estas rotas com o header `Authorization: Bearer SEU_TOKEN`:

```bash
# últimos pedidos
curl https://seudominio.com.br/admin/pedidos -H "Authorization: Bearer SEU_TOKEN"
# detalhe de um pedido, com histórico (webhook, mudanças de status, Shopify)
curl "https://seudominio.com.br/admin/pedido?id=PED-XXXX" -H "Authorization: Bearer SEU_TOKEN"
# reenviar à Shopify os pedidos pagos que falharam
curl -X POST https://seudominio.com.br/admin/reprocessar-shopify -H "Authorization: Bearer SEU_TOKEN"
```

O servidor também faz isso sozinho a cada 5 minutos:
- consulta na Cielo os Pix pendentes das últimas 24h, caso o webhook tenha se perdido;
- reenvia à Shopify os pedidos pagos que ainda não chegaram lá.

Um pedido nunca é enviado duas vezes para a Shopify, mesmo que o webhook e a consulta cheguem juntos.

## 7. Testar em sandbox e virar para produção

Com `CIELO_AMBIENTE=sandbox`, faça estes testes:
- [ ] Cartão final 1 aprovado, à vista e parcelado → pedido pago aparece na Shopify.
- [ ] Cartão final 2 → mensagem de recusa, nenhum pedido criado.
- [ ] Pix → QR Code aparece; ao pagar, a tela muda e o pedido é criado.
- [ ] O estoque baixa e o cliente recebe o e-mail da Shopify.

Depois troque para `CIELO_AMBIENTE=production` com as credenciais de produção, faça uma compra real de valor baixo e estorne no painel da Cielo.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `public/index.html` | Site de apresentação + guia de integração completo |
| `public/checkout.html` | Página do checkout: dados, entrega (com busca de CEP), cartão, Pix, resumo do carrinho |
| `server.js` | Carrinho com preços da Shopify, frete, parcelas, pedidos, rotas e webhook |
| `cielo.js` | Cielo: AccessToken do SOP, venda no cartão, Pix, consulta |
| `db.js` | Banco SQLite: tabelas de pedidos e eventos (histórico de cada pedido) |
| `shopify.js` | Shopify Admin GraphQL: busca variantes e cria o pedido pago |
| `shopify-tema/checkout-externo.liquid` | Script do tema que manda o carrinho para o checkout |

## Antes de vender de verdade

- Confira na documentação atual os endpoints do Silent Order Post (`cielo.js`) e os campos do `orderCreate` (`shopify.js`), porque Cielo e Shopify mudam esses detalhes.
- Se a Shopify recusar a criação de um pedido, o pagamento já foi feito: o erro fica gravado no banco e o servidor tenta de novo a cada 5 minutos. Veja em `/admin/pedidos`. O sistema **não estorna sozinho**.
- A Shopify não homologa checkouts externos e considera esse uso contrário aos termos dela. A alternativa oficial são os apps da Cielo na App Store da Shopify.
