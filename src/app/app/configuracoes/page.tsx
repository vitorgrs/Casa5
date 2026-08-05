import { ClockIcon, SettingsIcon, WalletIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import { asNumber, currency } from "@/lib/format";
import { addManualBalance, syncMercadoPago } from "./actions";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const params = await searchParams;
  const baseRoute = "/app/configuracoes";
  const { profile, supabase } = await requireActiveProfile();
  const { data: snapshots } = await supabase
    .from("wallet_snapshots")
    .select("id,balance,source,external_id,observed_at,created_at")
    .eq("household_id", profile.household_id)
    .order("observed_at", { ascending: false })
    .limit(12);
  const latest = snapshots?.[0];
  const mpConfigured = Boolean(process.env.MERCADO_PAGO_ACCESS_TOKEN);

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
        <div className="role-chip">
          <SettingsIcon /> Ambiente privado
        </div>
      </div>
      {params.success && (
        <div className="message success">{params.success}</div>
      )}
      {params.error && <div className="message error">{params.error}</div>}

      <div className="config-grid">
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
                <button
                  className="button secondary"
                  type="submit"
                  disabled={!mpConfigured}
                >
                  <WalletIcon /> Sincronizar Mercado Pago
                </button>
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
                <button className="button secondary" type="submit">
                  Registrar saldo
                </button>
              </form>
            </section>
          )}

          <section className="card pad">
            <h3 style={{ marginTop: 0 }}>Automação diária</h3>
            <p className="note">
              A Vercel executa uma rotina gratuita uma vez por dia, às 08:00 no
              horário de Fortaleza/Rio. Ela marca pagamentos atrasados, prepara
              despesas recorrentes do próximo mês e tenta importar o relatório
              mais recente do Mercado Pago.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
