# Casa Cinco

Aplicação privada para gerenciar as despesas, pagamentos e rotinas de limpeza de um apartamento compartilhado por cinco moradores.

## O que já está pronto

- Login por e-mail e senha com Supabase Auth.
- Acesso dos cinco moradores aos mesmos dados.
- Permissão de edição exclusiva para **Vitor Gabriel**.
- Despesas mensais, avulsas e recorrentes.
- Divisão igual com correção automática dos centavos.
- Divisão personalizada por morador, com validação da soma.
- Pagamento individual: pendente, pago, atrasado ou dispensado.
- Alertas visuais de vencimento próximo e atraso.
- Agosto/2026 pré-configurado com aluguel de **R$ 5.915,54**, vencimento em **07/08/2026**, dividido entre os cinco.
- Setembro/2026 pré-configurado com aluguel de **R$ 6.747,00**, vencimento em **07/09/2026**, aguardando divisão personalizada.
- Luz, gás e internet cadastrados como despesas previstas com valor e vencimento a definir.
- Integração server-side com os relatórios oficiais de saldo disponível do Mercado Pago.
- Registro manual de saldo como contingência.
- Tarefas de limpeza com pontos, ranking semanal, sequência de dias e histórico.
- Rodízio semanal sugerido automaticamente.
- Automação diária gratuita na Vercel para atrasos, recorrências e Mercado Pago.
- Banco protegido com Row Level Security (RLS).
- Layout responsivo, escuro e tecnológico.

## Tecnologias

- Next.js 16 (App Router e Server Actions)
- React 19
- Supabase Auth + PostgreSQL + RLS
- Vercel
- API de relatórios do Mercado Pago
- TypeScript e CSS puro

## 1. Criar o projeto no Supabase

1. Crie um projeto em `supabase.com`.
2. Abra **SQL Editor**.
3. Copie e execute todo o conteúdo de:

```text
supabase/migrations/001_initial.sql
```

O script cria as tabelas, políticas de segurança, os cinco moradores, as despesas iniciais e algumas tarefas de limpeza editáveis.

## 2. Definir o e-mail administrador do Vitor

Abra:

```text
supabase/bootstrap-admin.sql
```

Troque `EMAIL_DO_VITOR_AQUI` pelo e-mail que o Vitor usará no site e execute o arquivo no SQL Editor.

É recomendável fazer isso **antes** de criar a conta do Vitor. Assim, o primeiro login já será reconhecido como administrador. O script também funciona depois do cadastro.

## 3. Copiar as chaves do Supabase

No Supabase, abra **Project Settings → API** e copie:

- Project URL
- Publishable key
- Secret/service role key

Crie `.env.local` copiando `.env.example`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://SEU-PROJETO.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxx
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxxx
MERCADO_PAGO_ACCESS_TOKEN=APP_USR-xxxxxxxxx
CRON_SECRET=uma-chave-grande-e-aleatoria
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Nunca envie `.env.local` ao GitHub. A chave secreta do Supabase e o token do Mercado Pago são usados apenas no servidor.

## 4. Rodar localmente

Requer Node.js 22 ou superior.

```bash
npm install
npm run dev
```

Abra `http://localhost:3000`.

Crie primeiro a conta do Vitor usando exatamente o e-mail configurado no `bootstrap-admin.sql`.

## 5. Liberar os outros moradores

Há dois caminhos:

### Cadastrar o e-mail antes

O Vitor entra em **Moradores**, informa o e-mail de cada pessoa e salva. Quando ela criar a conta com esse e-mail, o acesso será liberado automaticamente.

### Associar uma solicitação já criada

A pessoa cria a conta primeiro. Ela ficará na tela de espera. O Vitor abre **Moradores → Solicitações pendentes** e associa a conta ao morador correto.

Os moradores terão acesso somente para leitura. O banco também bloqueia tentativas de edição fora do perfil administrador.

## 6. Configurar o Mercado Pago

1. Entre no painel de desenvolvedores do Mercado Pago.
2. Crie uma aplicação vinculada à conta que receberá o dinheiro da casa.
3. Copie o **Access Token de produção**.
4. Defina `MERCADO_PAGO_ACCESS_TOKEN` no ambiente local e na Vercel.

O sistema usa o relatório oficial de **saldo disponível (bank report)**:

1. Configura o relatório, caso ainda não exista.
2. Solicita a geração de um CSV dos últimos 35 dias.
3. Em uma execução posterior, importa o relatório pronto.
4. Calcula o saldo final somando créditos líquidos e subtraindo débitos líquidos.
5. Salva um snapshot no Supabase.

A geração é assíncrona. Por isso, o primeiro clique pode apenas solicitar o relatório; um clique posterior ou a automação do dia seguinte faz a importação.

## 7. Publicar gratuitamente na Vercel

### Opção recomendada: GitHub

1. Crie um repositório privado no GitHub.
2. Envie esta pasta para o repositório.
3. Na Vercel, clique em **Add New → Project**.
4. Importe o repositório.
5. Cadastre todas as variáveis de `.env.example` em **Settings → Environment Variables**.
6. Troque `NEXT_PUBLIC_APP_URL` pela URL final, por exemplo:

```env
NEXT_PUBLIC_APP_URL=https://casa-cinco.vercel.app
```

7. Faça um novo deploy depois de alterar as variáveis.

### Configuração do Supabase para produção

Em **Authentication → URL Configuration**:

- Site URL: URL final da Vercel.
- Redirect URLs: adicione `https://SEU-DOMINIO.vercel.app/auth/callback`.

## 8. Automação diária

O arquivo `vercel.json` agenda:

```text
/api/cron/daily
```

para `11:00 UTC`, equivalente a `08:00` no horário de Fortaleza/Rio de Janeiro.

A rotina:

- marca parcelas pendentes vencidas como atrasadas;
- cria despesas recorrentes do mês atual ou seguinte;
- copia a divisão do último mês da série;
- tenta importar o relatório mais recente do Mercado Pago;
- solicita um relatório novo para a próxima execução;
- grava um evento técnico no banco.

A rota exige o cabeçalho `Authorization: Bearer <CRON_SECRET>`.

## 9. Fluxo de uso recomendado

1. O Vitor cadastra ou ajusta as contas previstas do mês.
2. Define divisão igual ou personalizada.
3. Cada morador consulta quanto precisa enviar.
4. Após receber o Pix na conta do Mercado Pago, o Vitor marca o pagamento individual como pago.
5. O painel mostra total previsto, recebido, pendente e saldo da conta.
6. Na área **Casa em dia**, o Vitor registra quem concluiu cada limpeza.
7. O ranking e a sequência são atualizados automaticamente.

## Estrutura principal

```text
src/app/app/                 páginas autenticadas
src/app/app/despesas/        despesas, divisões e pagamentos
src/app/app/limpeza/         tarefas, pontos, ranking e check-ins
src/app/app/moradores/       e-mails e liberação de acesso
src/app/app/configuracoes/   saldo e Mercado Pago
src/app/api/cron/daily/      automação diária
src/lib/supabase/            clientes Supabase
supabase/migrations/         banco, RLS e dados iniciais
```

## Observação importante sobre o Mercado Pago

O relatório de saldo disponível é adequado para conciliação, mas não funciona como um websocket bancário em tempo real. O projeto atualiza o saldo por solicitação manual ou pela rotina diária gratuita. Para um apartamento, isso evita custos e mantém a integração simples e segura.

## Novidades desta atualização (permissões, organização, calendário, reembolsos, PIX, e-mail)

### 1. Rodar a migração nova

No SQL Editor do Supabase, depois do `001_initial.sql`, execute:

```text
supabase/migrations/002_features.sql
```

Recomenda-se testar primeiro em um projeto/branch de homologação do Supabase,
pois o arquivo altera políticas de RLS já existentes (principalmente a
leitura do saldo do Mercado Pago).

### 2. Permissões por morador

- Em **Configurações → Permissões dos moradores** (só o administrador vê),
  é possível liberar, para cada morador, qualquer combinação de:
  cadastrar/editar despesas, marcar despesas como pagas, ver o saldo do
  Mercado Pago, gerenciar o Casa em dia, gerenciar organização/calendário,
  gerenciar lista de compras e editar dados de moradores (e-mail/PIX).
- O administrador sempre tem acesso total, independentemente do que estiver
  marcado.
- A checagem é feita tanto na interface quanto no banco (RLS), então mesmo
  chamando a API diretamente não dá para burlar as permissões.

### 3. Minha página (`/app/eu`)

Painel pessoal com: despesas por mês (destacando o que ainda não foi pago),
reembolsos pendentes, tarefas do calendário do Casa em dia designadas à
pessoa e pendências gerais da Organização.

### 4. Casa em dia — calendário (`/app/limpeza/calendario`)

Calendário mensal clicável: clique em um dia para ver as tarefas registradas
nele ou cadastrar uma nova, com título e uma ou mais pessoas responsáveis.
O "responsável sugerido automaticamente por rodízio" foi removido do rodízio
de tarefas fixas — agora quem registra o check-in escolhe manualmente o
morador.

### 5. Organização (`/app/organizacao`)

- **Tarefas delegadas**: título, prazo e um ou vários responsáveis (ex.:
  "resolver a internet até dia 9" para um morador, ou "trocar a roupa de
  cama até dia 20" marcando todos). Cada responsável marca sua própria
  parte como concluída.
- **Lista de compras**: adicione itens com quantidade planejada; no
  supermercado, marque cada item como "no carrinho" pelo celular; depois,
  em qualquer momento, lance a quantidade comprada e o valor unitário de
  cada item para acompanhar o gasto real por item ao longo do tempo.

### 6. Reembolsos em despesas

Ao cadastrar ou editar uma despesa, marque "gera reembolso" e informe o
valor por pessoa (igual para todos os participantes da divisão). Isso:

1. Marca a parcela de cada morador como "reembolso pendente";
2. Cria automaticamente uma tarefa em Organização (não no calendário da
   casa) pedindo para solicitar o reembolso;
3. Permite marcar cada reembolso como pago individualmente na página de
   Despesas (mesma permissão de "marcar despesas como pagas").

### 7. Chave PIX

Em **Moradores**, cada morador pode ter uma chave PIX cadastrada por quem
tiver a permissão "gerenciar moradores" (ou o administrador). A chave fica
visível para todos os moradores ativos.

### 8. Lembretes de vencimento por e-mail (Resend)

- **É viável**: o plano gratuito do Resend permite 3.000 e-mails/mês e
  100/dia — muito mais do que uma casa de 5 pessoas usa mesmo enviando um
  lembrete por parcela em aberto todos os dias.
- Passos: crie uma conta no Resend, verifique um domínio de envio (Domains
  → Add Domain) e defina na Vercel:
  ```
  RESEND_API_KEY=re_...
  RESEND_FROM="Casa Cinco <avisos@seudominio.com>"
  NEXT_PUBLIC_APP_URL=https://SEU-APP.vercel.app
  ```
- Sem essas variáveis, os lembretes ficam desativados automaticamente (o
  resto do cron diário continua funcionando normalmente).
- Em Configurações, o administrador pode ligar/desligar os lembretes e
  escolher com quantos dias de antecedência avisar.
- Cada parcela recebe no máximo um lembrete por dia (controlado pela tabela
  `expense_reminder_log`), então não há risco de spam mesmo rodando o cron
  várias vezes.

### 9. Bug do Mercado Pago corrigido

**Causa raiz**: a API do Mercado Pago responde `202` quando aceita gerar um
novo relatório, mas responde `203 Non-Authoritative Information` quando
*entende* o pedido só que **não consegue gerar o relatório** — pedindo para
tentar de novo com as datas sugeridas pelo sistema. Como `203` também é um
status HTTP "2xx", o código antigo tratava qualquer resposta 2xx como
sucesso, então nunca percebia que o relatório não tinha sido criado de
verdade — por isso a mensagem genérica "nova atualização solicitada" se
repetia para sempre sem nenhum relatório aparecer.

Agora `generateBankReport` trata `202` e `203` separadamente, e a tela de
**Configurações** mostra o diagnóstico real depois de cada sincronização:
quantos relatórios existem, o status do mais recente e, se o Mercado Pago
recusou o pedido, o motivo devolvido por ele. Sincronize novamente pelo app
e leia a mensagem — ela agora conta o que está de fato acontecendo do lado
do Mercado Pago.

### 10. Responsividade mobile

Foi feita uma revisão geral do CSS para telas pequenas: menu lateral vira uma
barra inferior fixa no celular, grades de 2/3/4 colunas colapsam para uma
coluna, formulários, cards de despesas, calendário e tabelas passam a
ocupar a largura da tela sem cortar conteúdo. Ainda vale testar no seu
aparelho real após o deploy — ajustes finos de pixel podem ser necessários
em telas muito específicas.

## Atualização: comprovantes, correções de Mercado Pago/e-mail, redesenho do Casa em dia

### 1. Nova migração — comprovantes e boleto

Rode `supabase/migrations/004_receipts_storage.sql` depois da 003 (ou da 002).
Ela cria:
- `expenses.boleto_path/boleto_name/boleto_uploaded_at`
- `expense_shares.receipt_path/receipt_name/receipt_uploaded_by/receipt_uploaded_at`
- Um bucket **privado** no Storage chamado `comprovantes`, com políticas de
  RLS que restringem leitura/escrita aos moradores da mesma casa (e exclusão
  a quem tiver a permissão `manage_expenses`).

### 2. Comprovante de pagamento e boleto

- Em cada parcela de despesa, qualquer morador pode anexar o próprio
  comprovante (PDF ou foto) mesmo que a parcela já esteja paga. Quem tem a
  permissão de editar despesas ou marcar como paga também pode anexar em
  nome de qualquer morador.
- O botão "Marcar pago" abre um modal de confirmação **somente quando não
  há comprovante anexado**, perguntando se quer marcar como paga mesmo
  assim. Se já existe comprovante, marca direto.
- Cada despesa pode ter um boleto anexado (quem tem permissão de gerenciar
  despesas), ficando salvo e visível para todos os moradores da casa.
- Os arquivos são acessados por link temporário (30 minutos), gerado a cada
  carregamento da página — não há link público permanente.

### 3. Feedback de carregamento e "Cancelar"

- Novo componente `SubmitButton` mostra "Salvando..." com spinner e
  desabilita o botão enquanto a ação roda, resolvendo a sensação de "clique
  não fez nada" quando a Vercel demora alguns segundos.
- A navegação entre páginas já usa o `loading.tsx` do Next.js (skeleton),
  mantido como estava.
- Botão "Cancelar" adicionado aos formulários de nova/editar despesa, nova
  tarefa (Organização e calendário do Casa em dia), lançar compra.

### 4. Casa em dia — redesenho

- A página principal agora mostra o **calendário do mês** no lugar do
  quadro de tarefas sugeridas. Clique em um dia para abrir um modal grande
  com as tarefas daquele dia: título, descrição e quem fez (um ou mais
  moradores).
- O rodízio fixo de tarefas recorrentes (limpeza do banheiro, área comum
  etc.) continua existindo, agora em **Casa em dia → Rodízio fixo**
  (`/app/limpeza/rotina`).

### 5. Botões padronizados

Adicionado `white-space: nowrap` e tamanho fixo de ícone no CSS global, para
os botões de ação rápida (Minha página / Organização / Registrar limpeza /
Nova despesa) pararem de quebrar linha de forma desigual.

### 6. Mercado Pago — segundo bug encontrado

O primeiro bug (status 202/203) já tinha sido corrigido, mas havia um
**segundo problema mais grave**: o campo `status` retornado pela lista de
relatórios do Mercado Pago é sempre `"enabled"` — não indica se o relatório
terminou de processar. O código comparava `status === "processed"`, uma
condição que nunca acontece, então nenhum relatório era considerado pronto
e o saldo nunca era importado, mesmo com relatórios já existindo. Corrigido
para usar a presença de `file_name` como sinal real de que o relatório está
pronto para download.

### 7. E-mails — como testar e diagnosticar

Adicionei um botão **"Testar / enviar lembretes agora"** em Configurações
(admin) que roda a mesma lógica do cron manualmente e mostra o erro real do
Resend, se houver. Prováveis causas de nenhum e-mail ter chegado ainda:

1. **Domínio não verificado no Resend.** Seu `RESEND_FROM` usa
   `lembretes@casa5.com.br` — esse domínio precisa estar com o status
   "Verified" em Resend → Domains. Sem isso, o Resend rejeita o envio.
2. **`NEXT_PUBLIC_APP_URL=http://localhost:3000`** no seu `.env` de produção
   está incorreto — deveria ser a URL pública do seu app na Vercel (ex.:
   `https://casa5.vercel.app`). Isso não impede o envio, mas faz o link
   dentro do e-mail apontar para localhost.
3. **O cron da Vercel só roda 1x por dia** (plano gratuito). Se você acabou
   de configurar as variáveis, é normal ainda não ter rodado — use o botão
   de teste manual para não precisar esperar.
4. **Nenhuma despesa dentro da janela de lembrete** (padrão: 3 dias antes do
   vencimento) também faz o teste retornar "0 lembretes enviados" sem erro.

Use o botão de teste manual primeiro — ele vai dizer exatamente qual desses
casos está acontecendo.

## Atualização: rateio das compras da lista

Antes de publicar esta versão, rode no Supabase SQL Editor, depois da migração
004:

```text
supabase/migrations/005_shopping_splits.sql
```

A migração adiciona o pagador e o tipo da compra (`Casa toda`, `Grupo` ou
`Individual`), cria as parcelas por participante e as funções protegidas de
registro, envio de comprovante e confirmação do Pix.

No fluxo **Organização → Lista de compras → Lançar compra**:

1. Informe quantidade, valor unitário e quem pagou.
2. Escolha se a compra é geral, de um grupo ou individual.
3. Nas compras de grupo/individuais, selecione quem participa.
4. O sistema divide o total em centavos, já quita a parte do pagador quando
   ele participa e cria dívida para os demais.
5. Cada devedor vê na **Minha página** o valor, o nome e a chave PIX de quem
   pagou, podendo enviar um comprovante em PDF ou foto.
6. O pagador confere o arquivo na própria **Minha página** e marca o Pix como
   pago.

## Atualização: compra com vários itens e compensação de dívidas

Depois da migração 005, rode também:

```text
supabase/migrations/006_multi_item_purchases_and_netting.sql
```

O lançamento da compra agora funciona em lote:

- A lista pode ser pesquisada por nome, categoria ou observação.
- Nome e quantidade planejada podem ser editados enquanto o item está aberto.
- É possível selecionar vários itens, informar quantidade e valor unitário de
  cada um e conferir o subtotal e o total da compra em tempo real.
- Somente depois do total são escolhidos o pagador, o tipo da compra e os
  participantes do rateio.

Os débitos de compras também são compensados por dupla de moradores. Exemplo:
se você deve R$ 50,00 ao Patrick e ele deve R$ 25,00 a você, a **Minha página**
explica os dois valores e pede um Pix de apenas R$ 25,00. Um único comprovante
quita as dívidas usadas nessa compensação depois da confirmação do recebedor.

## Atualização: retirar item de uma compra lançada

Depois da migração 006, rode:

```text
supabase/migrations/007_remove_item_from_purchase.sql
```

Cada item de uma compra registrada passa a ter a ação **Retirar da compra**.
O item volta para a lista, o total é recalculado e o rateio dos itens restantes
é atualizado automaticamente. Se era o único item, a compra é encerrada.

Por segurança, o sistema não permite alterar a composição da compra quando já
existe comprovante pendente ou pagamento confirmado de algum participante.

## Atualização: compras administradas somente pelo administrador

Depois da migração 007, rode:

```text
supabase/migrations/008_admin_only_shopping.sql
```

Somente o administrador pode adicionar, editar, marcar ou excluir itens da
lista, lançar compras, desfazer lançamentos e retirar um item de uma compra.
Os demais moradores possuem acesso de leitura e pesquisa. O envio do próprio
comprovante e a confirmação pelo recebedor do PIX continuam disponíveis para
concluir o acerto financeiro.

## Atualização: comprovante e pagamento na página individual

Depois da migração 008, rode:

```text
supabase/migrations/009_individual_receipt_payment_flow.sql
```

O devedor envia o comprovante do PIX pela **Minha página**. O recebedor vê o
arquivo também na própria página individual e somente depois disso pode usar
**Marcar como pago**. A regra é validada no banco: sem comprovante, ou por uma
pessoa diferente do recebedor, o pagamento não pode ser baixado. Quando as
dívidas se compensam integralmente e nenhum PIX é necessário, a quitação por
compensação continua disponível sem comprovante.

## Atualização: comprovantes das despesas pelo administrador

Depois da migração 009, rode:

```text
supabase/migrations/010_expense_receipt_before_paid.sql
```

Na página **Despesas**, o administrador visualiza as parcelas de todos os
moradores, pode anexar o comprovante em nome de cada um e, depois do anexo,
marcar a parcela como paga. Sem comprovante, o botão de pagamento fica
bloqueado e o banco também rejeita a baixa. Para remover o comprovante de uma
parcela paga, primeiro é necessário desfazer o pagamento.
