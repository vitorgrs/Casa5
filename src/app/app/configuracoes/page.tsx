import Link from "next/link";
import { ClockIcon, SettingsIcon, WalletIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requireActiveProfile } from "@/lib/auth";
import { asNumber, currency } from "@/lib/format";
import { addManualBalance, sendRemindersNow, syncMercadoPago, updateReminderSettings } from "./actions";

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
  const resendConfigured = Boolean(process.env.RESEND_API_KEY) && Boolean(process.env.RESEND_FROM);

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
                ? `Última referência: ${new Date(latest.observed_at).toLocaleString("pt-BR")} • ${latest.source === "mercado_pago" ? "sincronização automática" : "registro manual"}`
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
                    <small>referência</small>
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
              A Vercel executa uma rotina gratuita uma vez por dia (agendada
              para 08:00 no horário de Fortaleza/Rio). No plano gratuito da
              Vercel, esse horário pode variar um pouco e o primeiro disparo
              só acontece na próxima janela depois do deploy — então é normal
              não ter rodado ainda se você acabou de configurar.
            </p>
            {lastRun ? (
              <div className="message info">
                Última execução: {new Date(lastRun.created_at).toLocaleString("pt-BR")}
                <br />
                Lembretes: {(lastRun.metadata as { reminders?: string })?.reminders ?? "—"}
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
          </section>

          {profile.role === "admin" && (
            <section className="card pad">
              <h3 style={{ marginTop: 0 }}>Lembretes de vencimento por e-mail</h3>
              <p className="note">
                Usa a API do Resend (plano gratuito: 3.000 e-mails/mês). É
                necessário verificar um domínio de envio no Resend (Domains →
                Add Domain) e definir <code>RESEND_API_KEY</code> e{" "}
                <code>RESEND_FROM</code> nas variáveis de ambiente da Vercel.
                Sem essas variáveis, os lembretes ficam desativados
                automaticamente. Se o domínio do <code>RESEND_FROM</code> não
                estiver verificado no Resend, os envios falham silenciosamente
                — use o botão de teste abaixo para ver o erro real.
              </p>
              <div className="message info">
                Status do Resend:{" "}
                <strong>{resendConfigured ? "variáveis configuradas" : "faltam variáveis"}</strong>
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
                <SubmitButton className="button ghost" disabled={!resendConfigured} pendingLabel="Enviando...">
                  Testar / enviar lembretes agora
                </SubmitButton>
              </form>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
