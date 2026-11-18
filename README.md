# Fluxofy — plataforma de checkout transparente (Shopify + Cielo)

Cada lojista cria uma conta no **painel**, conecta a própria loja Shopify e a própria conta Cielo, e cola uma linha no tema. O checkout cobra na Cielo do lojista e cria o pedido pago na Shopify dele.

| Endereço | O que é |
|---|---|
| `/` | Site de apresentação + guia de integração para lojistas |
| `/painel` | Painel do lojista: cadastro, Shopify, Cielo, checkout, pedidos |
| `/checkout?loja=<loja>&itens=<variante:qtd>` | Checkout de cada loja |
| `/checkout?itens=111:2,222:1` | Checkout de demonstração (simulação) |
| `/s/<loja>.js` | Script que o lojista cola no tema da Shopify |
| `/webhook/cielo?loja=<loja>` | URL de notificação que o lojista cadastra na Cielo |

## Rodar no computador

Precisa do **Node.js 22.5+**. Não há nada para instalar.

```bash
node server.js
```

Abra http://localhost:3000/painel, crie uma conta e siga os passos da tela Início.

## Publicar (Railway)

1. Suba **todos os arquivos** deste projeto para o repositório no GitHub (pode ser tudo solto na raiz; o servidor acha as páginas em qualquer pasta e prefere as que estão mais perto da raiz).
2. No Railway: o serviço já existente atualiza sozinho a cada commit.
3. **Volume:** botão direito no serviço → **Attach Volume** → mount path `/data`.
4. **Variables:**
   ```
   DB_ARQUIVO=/data/checkout.db
   SEGREDO_MESTRE=uma-frase-longa-e-aleatoria
   NIXPACKS_NODE_VERSION=22
   RAILPACK_NODE_VERSION=22
   ```
   Opcional: `CODIGO_CONVITE=...` para só aceitar cadastros com convite.
   Admin: `ADMIN_EMAILS=seu@email.com` (vários separados por vírgula).
5. As variáveis antigas `CIELO_*` e `SHOPIFY_*` não são mais usadas: cada lojista cadastra as suas no painel.
6. Teste: `https://SEU-ENDERECO/saude` deve responder `{"ok":true}` e `/painel` deve abrir a tela de login.

**Importante**
- Guarde o `SEGREDO_MESTRE`. Se ele mudar ou se perder, as credenciais salvas pelos lojistas não podem ser lidas e cada um terá de cadastrá-las de novo.
- Rode **uma instância só** (o banco é um arquivo SQLite) e faça backup do arquivo `/data/checkout.db`.

## Conta admin (dono da plataforma)

1. Crie a sua conta normalmente em `/painel` (com a sua senha).
2. No Railway, em **Variables**, crie `ADMIN_EMAILS` com o e-mail dessa conta.
3. Depois que o Railway reiniciar, entre de novo no painel: aparece a aba **Admin**, com:
   - resumo da plataforma (lojas, pedidos, receita, erros na Shopify);
   - todas as lojas, com dono, status da Shopify e da Cielo, pedidos e receita de 30 dias, e botão **Bloquear/Desbloquear** (loja bloqueada não aceita compras e o lojista vê um aviso);
   - os últimos 200 pedidos de todas as lojas.

O admin não vê as chaves da Shopify nem da Cielo dos lojistas.

## Appmax (segundo gateway)

Cada loja escolhe em **Integrações → Gateway de pagamento** se o checkout cobra pela **Cielo** ou pela **Appmax**. Na Appmax o cartão é tokenizado no navegador pelo script oficial (`appmax.min.js`), o pedido e o pagamento são criados pela API v1, o Pix mostra o QR Code da Appmax e o status é confirmado por webhook + consulta à API. Pagamentos em análise antifraude (`autorizado`) ficam pendentes até a Appmax aprovar.

**Cadastrar o app Fluxofy na Appmax (uma vez, pelo dono da plataforma):**

1. Peça acesso ao **portal de desenvolvedores da Appmax** e entre no ambiente **sandbox** primeiro.
2. Crie um aplicativo e preencha:
   - **URL de validação:** `https://SEU-DOMINIO/appmax/validar`
   - **URL do webhook:** `https://SEU-DOMINIO/webhook/appmax` (marque pelo menos pedido pago, pedido aprovado, Pix pago, Pix expirado, estorno e estorno parcial)
   - **URL de retorno/callback**, se o formulário pedir: `https://SEU-DOMINIO/appmax/retorno`
3. Anote: o **App ID** (UUID), o **ID numérico** do app (é o `app_id` que a Appmax envia na validação), o **Client ID** e o **Client Secret** do app.
4. No Railway, em **Variables**, crie `APPMAX_AMBIENTE=sandbox`, `APPMAX_APP_ID`, `APPMAX_APP_ID_NUM`, `APPMAX_CLIENT_ID` e `APPMAX_CLIENT_SECRET`. Os logs mostram `Appmax: app … (sandbox)` quando estiver certo.
5. No painel de uma loja de teste: **Integrações → Appmax → Conectar Appmax**. Você autoriza na Appmax e volta com a loja conectada e a Appmax como gateway.
6. Teste no checkout com os cartões de teste da Appmax (sandbox): `4000 0000 0000 0010` aprovado, `…0028` em análise, `…0002` recusado. Pix com qualquer CPF válido aprova sozinho em ~5 s.
7. Quando a Appmax aprovar o app para produção, troque `APPMAX_AMBIENTE=production` e as credenciais do app, e os lojistas conectam de novo pelo botão.

Sem as variáveis, o lojista ainda pode colar à mão Client ID, Client Secret e External ID em **Integrações → Appmax**.

## Pagar.me (terceiro gateway)

O lojista conecta em **Integrações → Pagar.me** e escolhe **Pagar.me** em **Gateway de pagamento**. Não precisa de variável no Railway.

1. No painel da Pagar.me (conta na **API v5**): **Configurações → Chaves de API**. Copie a chave pública (`pk_…`) e a secreta (`sk_…`). Para testar, use `pk_test_` e `sk_test_`.
2. Cole as duas no Fluxofy, **Salvar** e **Testar chaves** (o teste avisa se uma é de teste e a outra de produção).
3. Na Pagar.me, cadastre o **domínio do checkout** (o do Fluxofy). Sem isso o cartão é bloqueado no navegador.
4. Na Pagar.me, **Configurações → Webhooks**: URL `https://SEU-DOMINIO/webhook/pagarme?loja=SUA-LOJA` (aparece pronta no painel), eventos `order.paid`, `order.payment_failed`, `order.canceled`, `charge.paid`, `charge.refunded`, `charge.payment_failed`.

Como funciona: o navegador troca o cartão por um token direto na Pagar.me (chave pública); o servidor cria o pedido com `card_token` ou Pix. Quando a Pagar.me confirma (na hora no cartão, ou pelo webhook/consulta no Pix), o pedido vira **pago** e é criado/marcado como **pago na Shopify** com o gateway "Pagar.me". O webhook nunca é aceito sozinho: o status é sempre conferido na API com a chave da loja. Reembolso total ou parcial cancela a cobrança pela API.

## Planos e faturas (cobrança dos lojistas)

- **Planos** (Admin → Planos): mensalidade + comissão sobre vendas aprovadas. Padrão: 0 de mensalidade e **1%** por venda. Cada loja pode ter um plano (coluna Plano na lista de lojas).
- **Ciclo mensal** por loja, a partir de quando a cobrança começa (nada retroativo). No fim do ciclo é gerada uma fatura: comissão sobre (total pago − reembolsos) dos pedidos do ciclo, mais a mensalidade.
- **Conta de cobrança** (Admin → Conta de cobrança): chaves Pagar.me **da plataforma**. Cadastre na Pagar.me o webhook mostrado ali e o domínio do painel.
- O lojista paga em **Plano e faturas** com Pix ou cartão; o cartão pode ficar salvo e as próximas faturas são cobradas sozinhas (até 4 tentativas, 1 por dia).
- **Fatura vencida** (fim do ciclo + "dias para pagar") **bloqueia o checkout** da loja. Ao pagar, libera na hora. O admin pode marcar como paga, isentar ou desbloquear manualmente (aí a cobrança não volta a bloquear por 7 dias).
- Sem a conta de cobrança configurada, as faturas aparecem mas ninguém é bloqueado.

## E-mails transacionais

Enviados pelo **Resend** (API HTTP; o Railway costuma bloquear SMTP). O dono configura uma vez em **Admin → Envio de e-mails**: e-mail remetente de um domínio verificado no Resend e a chave `re_…`. Sem isso, os e-mails ficam no histórico como "simulados".

Cada loja, em **E-mails**: nome do remetente, "responder para", e-mail para avisos de venda, ativar/desativar e editar cada e-mail (variáveis `{{...}}`, botão `[Texto](link)`), pré-visualizar e enviar teste. Eventos: pedido aprovado, Pix gerado, carrinho abandonado (após X minutos, com link de recuperação), reembolso e nova venda (para o lojista). Cada e-mail é enviado no máximo uma vez por pedido/evento. Links usam `RAILWAY_PUBLIC_DOMAIN` (ou `URL_PUBLICA`).

## O lojista faz pelo painel

1. **Shopify:** cria um app no Dev Dashboard (escopos `read_products` e `write_orders`), instala na loja e cola URL `.myshopify.com`, Client ID e Client Secret. Botão **Testar conexão**.
2. **Cielo:** ambiente, MerchantId, MerchantKey, ClientId/Secret do Silent Order Post, Cartão/Pix. Botão **Testar credenciais**. Copia a URL do webhook para a Cielo.
3. **Tema:** copia a linha `<script src=".../s/<loja>.js" defer></script>` e cola no `theme.liquid`.
4. **Checkout:** nome, cor, parcelas, juros, frete, nome na fatura.
5. **Links para anúncios da Meta:** busca um produto e copia o link direto para o checkout.
6. **Pedidos:** lista, detalhe com histórico e botão para reenviar à Shopify.

## Vendas (submenu do painel)

- **Pedidos:** lista, detalhe com histórico, reenvio à Shopify e **Reembolsar** (total ou parcial, estornado na Cielo).
- **Pedidos de reembolso:** tudo o que foi reembolsado pelo painel. O reembolso na Shopify ainda é registrado manualmente (o histórico do pedido avisa).
- **Checkout abandonado:** o checkout registra quem preencheu e-mail ou WhatsApp e não pagou (inclui cartão recusado e Pix não pago). Compra normal não conta como abandono.
- **Recuperação manual:** fila de contatos com botões de WhatsApp e e-mail, mensagem editável ({nome}, {loja}, {valor}, {link}) e link que reabre o checkout com o carrinho e o contato preenchidos. Conta como recuperado quem volta pelo link, foi contatado ou paga mais de 1 hora depois.
- **Links de pagamento:** cobre qualquer valor sem produto na Shopify, com ou sem endereço de entrega; mostra vendas por link e permite desativar.

## Segurança

- Senhas com scrypt; sessão em cookie HttpOnly/SameSite; limite de tentativas de login.
- Credenciais dos lojistas criptografadas (AES-256-GCM) e mascaradas no painel.
- Rotas do painel só aceitam JSON (bloqueia envio de formulários de outros sites).
- O número do cartão vai do navegador direto para a Cielo (Silent Order Post).

## Arquivos

| Arquivo | O que faz |
|---|---|
| `public/index.html` | Site + guia para lojistas |
| `public/painel.html` | Painel do lojista |
| `public/checkout.html` | Checkout (cartão, Pix, entrega, resumo) |
| `server.js` | Rotas, contas, configurações por loja, pedidos, webhook, conciliação |
| `cielo.js` / `appmax.js` / `pagarme.js` / `shopify.js` | Integrações de pagamento e loja |
| `db.js` / `cripto.js` | Banco SQLite, senhas e criptografia |

## Antes de vender de verdade

- Confira na documentação atual os endpoints do Silent Order Post (`cielo.js`) e os campos de `orderCreate`/`orderMarkAsPaid` (`shopify.js`).
- A Shopify não homologa checkouts externos e considera esse uso contrário aos termos dela. A alternativa oficial são os apps da Cielo na App Store da Shopify.
