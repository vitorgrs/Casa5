import Link from "next/link";
import { ClockIcon, SettingsIcon, WalletIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requireActiveProfile } from "@/lib/auth";
import { emailConfigured, emailProviderName } from "@/lib/email";
import { asNumber, currency } from "@/lib/format";
import {
  addManualBalance,
  sendDailyEmailsNow,
  sendOpenSettlementsNow,
  sendRemindersNow,
  syncMercadoPago,
  updateReminderSettings,
} from "./actions";

function ageLabel(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  if (hours < 1) return "há menos de 1 hora";
  if (hours < 24) return `há ${hours} hora${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `há ${days} dia${days === 1 ? "" : "s"}`;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const params = await searchParams;
  const baseRoute = "/app/configuracoes";
  const { profile, supabase } = await requireActiveProfile();
  const canViewWallet = can(profile, "view_wallet_balance");
  const { data: snapshots } = canViewWallet
    ? await supabase
        .from("wallet_snapshots")
        .select("id,balance,source,external_id,observed_at,created_at")
        .eq("household_id", profile.household_id)
        .order("observed_at", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(12)
    : { data: [] as { id: string; balance: number; source: string; external_id: string | null; observed_at: string; created_at: string }[] };
  const latest = snapshots?.[0];
  const mpConfigured = Boolean(process.env.MERCADO_PAGO_ACCESS_TOKEN);
  const { data: reminderSettings } = await supabase
    .from("household_settings")
    .select("reminders_enabled,reminder_days_before")
    .eq("household_id", profile.household_id)
    .maybeSingle();
  const { data: lastRun } = await supabase
    .from("system_events")
    .select("created_at,detail,metadata")
    .eq("household_id", profile.household_id)
    .eq("event_type", "daily_automation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: lastMorningRun } = await supabase
    .from("system_events")
    .select("created_at,detail,metadata")
    .eq("household_id", profile.household_id)
    .eq("event_type", "daily_chore_reminder")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const emailReady = emailConfigured();
  const emailProvider = emailProviderName();

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Integrações e segurança</span>
          <h1>Configurações</h1>
          <p>
            Conexão do Mercado Pago, saldo manual e informações técnicas do
            ambiente.
          </p>
        </div>
        <div className="page-actions">
          {profile.role === "admin" && (
            <Link className="button secondary" href="/app/configuracoes/permissoes">
              <SettingsIcon /> Permissões dos moradores
            </Link>
          )}
          <div className="role-chip">
            <SettingsIcon /> Ambiente privado
          </div>
        </div>
      </div>
      {params.success && (
        <div className="message success">{params.success}</div>
      )}
      {params.error && <div className="message error">{params.error}</div>}

      <div className="config-grid">
        {canViewWallet ? (
        <div className="grid">
          <section className="card pad wallet-card">
            <span className="eyebrow bright">
              Conta compartilhada • Mercado Pago
            </span>
            <div className="wallet-balance">
              {latest
                ? currency.format(asNumber(latest.balance))
                : "Saldo ainda não registrado"}
            </div>
            <div className="wallet-meta">
              {latest
                ? latest.source === "mercado_pago"
                  ? `Saldo referente a ${new Date(latest.observed_at).toLocaleString("pt-BR")} (${ageLabel(latest.observed_at)}) • importado em ${new Date(latest.created_at).toLocaleString("pt-BR")}`
                  : `Saldo informado manualmente em ${new Date(latest.observed_at).toLocaleString("pt-BR")}`
                : "Configure o token e solicite a primeira sincronização."}
            </div>
            {profile.role === "admin" && (
              <form action={syncMercadoPago} style={{ marginTop: 22 }}>
                <SubmitButton
                  className="button secondary"
                  disabled={!mpConfigured}
                  pendingLabel="Sincronizando..."
                >
                  <WalletIcon /> Sincronizar Mercado Pago
                </SubmitButton>
              </form>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Histórico de saldo</h2>
                <span className="muted-text" style={{ fontSize: 10 }}>
                  Snapshots preservam o valor observado em cada sincronização.
                </span>
              </div>
              <ClockIcon />
            </div>
            <div className="list">
              {(snapshots ?? []).map((snapshot) => (
                <div className="list-row" key={snapshot.id}>
                  <div className="item-title">
                    <strong>
                      {snapshot.source === "mercado_pago"
                        ? "Mercado Pago"
                        : "Registro manual"}
                    </strong>
                    <small>
                      {snapshot.external_id ?? "Informado pelo administrador"}
                    </small>
                  </div>
                  <div className="item-value">
                    <strong>
                      {currency.format(asNumber(snapshot.balance))}
                    </strong>
                    <small>saldo</small>
                  </div>
                  <div className="item-value">
                    <strong>
                      {new Date(snapshot.observed_at).toLocaleDateString(
                        "pt-BR",
                      )}
                    </strong>
                    <small>
                      {snapshot.source === "mercado_pago"
                        ? `referência • ${ageLabel(snapshot.observed_at)}`
                        : "registro manual"}
                    </small>
                  </div>
                  <span
                    className={`status-pill ${snapshot.source === "mercado_pago" ? "success" : "info"}`}
                  >
                    {snapshot.source === "mercado_pago"
                      ? "Automático"
                      : "Manual"}
                  </span>
                </div>
              ))}
              {(snapshots ?? []).length === 0 && (
                <div className="empty">Nenhum saldo registrado.</div>
              )}
            </div>
          </section>
        </div>
        ) : (
          <div className="card pad">
            <div className="empty">
              Você não tem permissão para ver o saldo do Mercado Pago. Peça ao
              administrador para liberar em Permissões dos moradores.
            </div>
          </div>
        )}

        <div className="grid">
          <section className="card pad">
            <h3 style={{ marginTop: 0 }}>Conexão automática</h3>
            <p className="note">
              O token fica somente nas variáveis protegidas da Vercel. O sistema
              solicita o relatório oficial de saldo disponível do Mercado Pago,
              importa o CSV quando estiver pronto e calcula o saldo final pelas
              entradas e saídas líquidas.
            </p>
            <div className="message info">
              Status do token:{" "}
              <strong>
                {mpConfigured ? "configurado" : "não configurado"}
              </strong>
            </div>
            <div className="code-box">
              MERCADO_PAGO_ACCESS_TOKEN=APP_USR-...
            </div>
            <p className="note">
              A geração do relatório é assíncrona. Na primeira tentativa,
              normalmente o site apenas solicita o relatório; a tentativa
              seguinte importa o arquivo pronto.
            </p>
          </section>

          {profile.role === "admin" && (
            <section className="card pad">
              <h3 style={{ marginTop: 0 }}>Informar saldo manualmente</h3>
              <p className="note">
                Use como contingência enquanto a integração ainda não estiver
                configurada ou quando quiser registrar uma conferência.
              </p>
              <form action={addManualBalance} className="stack-form">
                <input type="hidden" name="redirect_to" value={baseRoute} />
                <label>
                  Saldo atual
                  <input
                    name="balance"
                    inputMode="decimal"
                    required
                    placeholder="0,00"
                  />
                </label>
                <SubmitButton className="button secondary" pendingLabel="Registrando...">
                  Registrar saldo
                </SubmitButton>
              </form>
            </section>
          )}

          <section className="card pad">
            <h3 style={{ marginTop: 0 }}>Automação diária</h3>
            <p className="note">
              A Vercel envia o lembrete da casa às 06:00 e executa a rotina
              financeira às 07:00, no horário de Fortaleza/Rio. No plano
              gratuito, o horário pode variar dentro da janela e o primeiro
              disparo só acontece depois do deploy — então é normal não ter
              rodado ainda se você acabou de configurar.
            </p>
            <div className={`message ${emailReady ? "success" : "info"}`}>
              E-mail para o responsável pelas tarefas do dia:{" "}
              <strong>
                {emailReady
                  ? `ativo com ${emailProvider}`
                  : "aguardando a configuração do provedor"}
              </strong>
              <br />
              A rotina identifica a pessoa da escala e tenta enviar uma única
              mensagem por dia. Não há uma chave separada para ativar ou
              desativar esse lembrete.
            </div>
            {lastRun ? (
              <div className="message info">
                Última execução: {new Date(lastRun.created_at).toLocaleString("pt-BR")}
                <br />
                Lembretes: {(lastRun.metadata as { reminders?: string })?.reminders ?? "—"}
                <br />
                Rotina da casa: {(lastRun.metadata as { choreReminder?: string })?.choreReminder ?? "—"}
                <br />
                Mercado Pago: {(lastRun.metadata as { mercadoPago?: string })?.mercadoPago ?? "—"}
              </div>
            ) : (
              <div className="message info">
                Ainda não há registro de nenhuma execução automática para esta
                casa. Confira em Vercel {"->"} seu projeto {"->"} aba Cron Jobs
                se o job está agendado e se já rodou.
              </div>
            )}
            {lastMorningRun ? (
              <div className="message info" style={{ marginTop: 10 }}>
                Último cron de e-mails: {new Date(lastMorningRun.created_at).toLocaleString("pt-BR")}
                <br />
                Rotina da casa: {(lastMorningRun.metadata as { choreReminder?: { message?: string } })?.choreReminder?.message ?? "—"}
                <br />
                Lavanderia: {(lastMorningRun.metadata as { laundryReminder?: { message?: string } })?.laundryReminder?.message ?? "—"}
              </div>
            ) : (
              <div className="message info" style={{ marginTop: 10 }}>
                O cron de e-mails das 06:00 ainda não registrou nenhuma execução.
              </div>
            )}
            {profile.role === "admin" && (
              <form action={sendDailyEmailsNow} style={{ marginTop: 12 }}>
                <input type="hidden" name="redirect_to" value="/app/configuracoes" />
                <SubmitButton
                  className="button secondary"
                  disabled={!emailReady}
                  pendingLabel="Processando e-mails..."
                >
                  Processar e-mails de hoje agora
                </SubmitButton>
              </form>
            )}
          </section>

          {profile.role === "admin" && (
            <section className="card pad">
              <h3 style={{ marginTop: 0 }}>Lembretes de vencimento por e-mail</h3>
              <p className="note">
                Usa Resend ou Brevo. Configure <code>RESEND_API_KEY</code> e{" "}
                <code>RESEND_FROM</code>, ou <code>BREVO_API_KEY</code> e{" "}
                <code>BREVO_FROM_EMAIL</code>, nas variáveis da Vercel. O
                remetente precisa estar verificado no provedor.
              </p>
              <div className="message info">
                Status do e-mail:{" "}
                <strong>
                  {emailReady
                    ? `credenciais do ${emailProvider} presentes`
                    : "faltam variáveis válidas"}
                </strong>
                {emailReady && (
                  <>
                    <br />
                    A aceitação dos envios ainda depende de o remetente estar
                    verificado no provedor.
                  </>
                )}
              </div>
              <form action={updateReminderSettings} className="stack-form">
                <input type="hidden" name="redirect_to" value="/app/configuracoes" />
                <label style={{ flexDirection: "row", alignItems: "center", gap: 10, display: "flex" }}>
                  <input
                    type="checkbox"
                    name="reminders_enabled"
                    defaultChecked={reminderSettings?.reminders_enabled ?? true}
                  />
                  Lembretes ativados
                </label>
                <label>
                  Enviar aviso com quantos dias de antecedência?
                  <input
                    name="reminder_days_before"
                    type="number"
                    min={0}
                    max={14}
                    defaultValue={reminderSettings?.reminder_days_before ?? 3}
                  />
                </label>
                <SubmitButton className="button secondary" pendingLabel="Salvando...">
                  Salvar preferências
                </SubmitButton>
              </form>
              <form action={sendRemindersNow} style={{ marginTop: 12 }}>
                <input type="hidden" name="redirect_to" value="/app/configuracoes" />
                <SubmitButton className="button ghost" disabled={!emailReady} pendingLabel="Enviando...">
                  Enviar lembretes de vencimento agora
                </SubmitButton>
              </form>
            </section>
          )}

          {profile.role === "admin" && (
            <section className="card pad">
              <h3 style={{ marginTop: 0 }}>E-mail de acerto de contas</h3>
              <p className="note">
                Envia um resumo bonito e detalhado para cada morador que ainda
                precisa pagar alguém. O e-mail mostra as compras, a compensação
                entre as dívidas, o valor final e a chave PIX de cada pessoa que
                deve receber. Quem não deve nada não recebe e-mail.
              </p>
              <div className="message info">
                O disparo é manual e acontece somente quando você apertar o
                botão. Antes de enviar, confira se os e-mails e as chaves PIX
                estão atualizados em Moradores.
              </div>
              <form action={sendOpenSettlementsNow} style={{ marginTop: 12 }}>
                <input type="hidden" name="redirect_to" value="/app/configuracoes" />
                <SubmitButton
                  className="button secondary"
                  disabled={!emailReady}
                  pendingLabel="Enviando acertos..."
                >
                  Enviar acertos em aberto
                </SubmitButton>
              </form>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
