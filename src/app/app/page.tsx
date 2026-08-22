import Link from "next/link";
import { ArrowIcon, CalendarIcon, CheckIcon, ClockIcon, WalletIcon } from "@/components/icons";
import { StatusPill } from "@/components/status-pill";
import { can, requireActiveProfile } from "@/lib/auth";
import {
  addDays,
  formatHouseDate,
  rotationMemberForDate,
  STANDARD_DAILY_TASKS,
  todayIso,
  type RotationMember,
  type RotationSwap,
} from "@/lib/chore-rotation";
import { asNumber, currency, daysUntil, monthLabel } from "@/lib/format";

type MemberRelation = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
} | null;

function dashboardMonth() {
  const today = todayIso();
  return today < "2026-08-01" ? "2026-08-01" : `${today.slice(0, 7)}-01`;
}

export default async function DashboardPage() {
  const { profile, supabase } = await requireActiveProfile();
  const canViewWallet = can(profile, "view_wallet_balance");
  const referenceMonth = dashboardMonth();
  const monthDate = new Date(`${referenceMonth}T00:00:00.000Z`);
  const today = todayIso();

  const [
    expenseResult,
    walletResult,
    membersResult,
    settingsResult,
    rotationResult,
    swapsResult,
  ] = await Promise.all([
    supabase
      .from("expenses")
      .select(
        "id,title,category,due_date,amount,status,estimated,expense_shares(id,amount,payment_status,member:household_members(id,name,initials,color_key))",
      )
      .eq("household_id", profile.household_id)
      .eq("reference_month", referenceMonth)
      .order("due_date", { ascending: true, nullsFirst: false }),
    canViewWallet
      ? supabase
          .from("wallet_snapshots")
          .select("balance,source,observed_at,created_at")
          .eq("household_id", profile.household_id)
          .order("observed_at", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("household_members")
      .select("id,name,initials,color_key,display_order")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
    supabase
      .from("daily_rotation_settings")
      .select("start_date")
      .eq("household_id", profile.household_id)
      .maybeSingle(),
    supabase
      .from("daily_rotation_members")
      .select("member_id,rotation_order")
      .eq("household_id", profile.household_id),
    supabase
      .from("chore_day_swap_requests")
      .select("requester_member_id,requester_date,target_member_id,target_date,status")
      .eq("household_id", profile.household_id),
  ]);

  const expenses = expenseResult.data ?? [];
  const members = membersResult.data ?? [];
  const total = expenses.reduce((sum, expense) => sum + asNumber(expense.amount), 0);
  const allShares = expenses.flatMap((expense) => expense.expense_shares ?? []);
  const received = allShares
    .filter((share) => share.payment_status === "paid")
    .reduce((sum, share) => sum + asNumber(share.amount), 0);
  const pendingPeople = new Set(
    allShares
      .filter(
        (share) =>
          share.payment_status !== "paid" && share.payment_status !== "waived",
      )
      .map((share) => {
        const member = (Array.isArray(share.member) ? share.member[0] : share.member) as MemberRelation;
        return member?.id;
      })
      .filter(Boolean),
  ).size;
  const alerts = expenses.filter((expense) => {
    const days = daysUntil(expense.due_date);
    return (
      days !== null &&
      days <= 5 &&
      expense.status !== "paid" &&
      expense.status !== "cancelled"
    );
  });
  const progress = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  const orderMap = new Map(
    (rotationResult.data ?? []).map((row) => [row.member_id, row.rotation_order]),
  );
  const rotationMembers: RotationMember[] = members
    .map((member) => ({
      id: member.id,
      name: member.name,
      initials: member.initials,
      color_key: member.color_key,
      rotation_order: orderMap.get(member.id) ?? member.display_order,
    }))
    .sort((first, second) => first.rotation_order - second.rotation_order);
  const swaps = (swapsResult.data ?? []) as RotationSwap[];
  const upcomingRotation = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index);
    return {
      date,
      member: rotationMemberForDate(
        date,
        settingsResult.data?.start_date ?? null,
        rotationMembers,
        swaps,
      ),
    };
  }).filter((row): row is { date: string; member: RotationMember } => Boolean(row.member));
  const nextDuty = upcomingRotation[0] ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Visão geral • {monthLabel.format(monthDate)}</span>
          <h1>Bom dia, {profile.full_name.split(" ")[0]}.</h1>
          <p>Acompanhe o que vence, o que já entrou e a escala diária do apartamento.</p>
        </div>
        <div className="page-actions">
          <Link className="button ghost" href="/app/eu">Minha página</Link>
          <Link className="button secondary" href="/app/limpeza">
            <CalendarIcon /> Ver escala
          </Link>
          {can(profile, "manage_expenses") && (
            <Link className="button primary" href={`/app/despesas?month=${referenceMonth.slice(0, 7)}&novo=1`}>
              <WalletIcon /> Nova despesa
            </Link>
          )}
        </div>
      </div>

      <div className="grid cols-4">
        <div className="card metric-card">
          <div className="metric-top"><span>Gastos do mês</span><span className="metric-icon"><WalletIcon /></span></div>
          <strong className="metric-value">{currency.format(total)}</strong>
          <span className="metric-foot">{expenses.length} contas e compras</span>
        </div>
        <div className="card metric-card">
          <div className="metric-top"><span>Já confirmado</span><span className="metric-icon"><ArrowIcon /></span></div>
          <strong className="metric-value">{currency.format(received)}</strong>
          <span className="metric-foot good">{progress}% arrecadado</span>
        </div>
        <div className="card metric-card">
          <div className="metric-top"><span>Saldo Mercado Pago</span><span className="metric-icon"><WalletIcon /></span></div>
          <strong className="metric-value">
            {!canViewWallet
              ? "Sem acesso"
              : walletResult.data
                ? currency.format(asNumber(walletResult.data.balance))
                : "Não sincronizado"}
          </strong>
          <span className="metric-foot">
            {!canViewWallet
              ? "Peça permissão ao administrador"
              : walletResult.data
                ? `Atualizado em ${new Date(walletResult.data.observed_at).toLocaleDateString("pt-BR")}`
                : "Configure o token em Configurações"}
          </span>
        </div>
        <div className="card metric-card">
          <div className="metric-top"><span>Pendências</span><span className="metric-icon"><ClockIcon /></span></div>
          <strong className="metric-value">{pendingPeople}</strong>
          <span className="metric-foot warn">moradores com valores em aberto</span>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Contas e despesas</h2>
              <span className="muted-text">Progresso de pagamento deste mês</span>
            </div>
            <Link href={`/app/despesas?month=${referenceMonth.slice(0, 7)}`} className="button ghost small">
              Ver todas <ArrowIcon />
            </Link>
          </div>
          <div style={{ padding: "18px 20px 8px" }}>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            <div className="progress-label">
              <span>{currency.format(received)} recebidos</span>
              <span>{currency.format(Math.max(0, total - received))} pendentes</span>
            </div>
          </div>
          <div className="list">
            {expenses.slice(0, 6).map((expense) => {
              const paid = (expense.expense_shares ?? []).filter(
                (share) => share.payment_status === "paid",
              ).length;
              const totalShares = expense.expense_shares?.length ?? 0;
              return (
                <div className="list-row" key={expense.id}>
                  <div className="item-title">
                    <strong>{expense.title}</strong>
                    <small>{expense.category}{expense.estimated ? " • valor estimado" : ""}</small>
                  </div>
                  <div className="item-value">
                    <strong>{expense.amount === null ? "A definir" : currency.format(asNumber(expense.amount))}</strong>
                    <small>{paid}/{totalShares} pagamentos</small>
                  </div>
                  <div className="item-value">
                    <strong>{expense.due_date ? formatHouseDate(expense.due_date) : "Sem data"}</strong>
                    <small>vencimento</small>
                  </div>
                  <StatusPill status={expense.status} />
                </div>
              );
            })}
            {expenses.length === 0 && <div className="empty">Nenhuma despesa cadastrada para o período.</div>}
          </div>
        </section>

        <div className="grid">
          <section className="card pad">
            <div className="card-head" style={{ padding: 0, paddingBottom: 15, marginBottom: 15 }}>
              <h3>Alertas próximos</h3><CalendarIcon />
            </div>
            <div className="alert-list">
              {alerts.slice(0, 4).map((expense) => {
                const days = daysUntil(expense.due_date) ?? 0;
                return (
                  <div className="alert-item" key={expense.id}>
                    <span className={`alert-dot ${days < 0 ? "red" : ""}`} />
                    <div>
                      <strong>{expense.title}</strong>
                      <small>
                        {days < 0 ? `${Math.abs(days)} dia(s) em atraso` : days === 0 ? "Vence hoje" : `Vence em ${days} dia(s)`}
                        {" • "}{expense.amount === null ? "valor a definir" : currency.format(asNumber(expense.amount))}
                      </small>
                    </div>
                  </div>
                );
              })}
              {alerts.length === 0 && <div className="empty" style={{ padding: 12 }}>Nenhum vencimento urgente.</div>}
            </div>
          </section>

          <section className="card pad next-duty-card">
            <div className="metric-top"><span>Próximo responsável</span><CalendarIcon /></div>
            {nextDuty ? (
              <div className="next-duty-person">
                <div className={`avatar avatar-${nextDuty.member.color_key}`}>{nextDuty.member.initials}</div>
                <div>
                  <strong>{nextDuty.member.name}</strong>
                  <small>{nextDuty.date === today ? "hoje" : formatHouseDate(nextDuty.date)}</small>
                </div>
              </div>
            ) : (
              <div className="empty">A escala ainda não foi configurada.</div>
            )}
          </section>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Próximos dias da escala</h2>
              <span className="muted-text">Um responsável por dia, em ordem contínua.</span>
            </div>
            <Link href="/app/limpeza" className="button ghost small">Abrir calendário <ArrowIcon /></Link>
          </div>
          <div className="list">
            {upcomingRotation.map((row) => (
              <div className="list-row" key={row.date}>
                <div className="item-title">
                  <strong>{row.date === today ? "Hoje" : formatHouseDate(row.date, { weekday: "long", day: "2-digit", month: "long" })}</strong>
                  <small>Responsável pelas tarefas padrão</small>
                </div>
                <div className="leader-person">
                  <div className={`avatar avatar-${row.member.color_key}`}>{row.member.initials}</div>
                  <strong>{row.member.name}</strong>
                </div>
              </div>
            ))}
            {upcomingRotation.length === 0 && <div className="empty">A escala ainda não começou.</div>}
          </div>
        </section>

        <section className="card pad">
          <div className="card-head" style={{ padding: 0, paddingBottom: 15, marginBottom: 15 }}>
            <h3>Tarefas de todos os dias</h3><CheckIcon />
          </div>
          <div className="daily-summary-list">
            {STANDARD_DAILY_TASKS.map((task) => (
              <div key={task.key}><span className="daily-task-check completed"><CheckIcon /></span>{task.label}</div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
