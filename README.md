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
