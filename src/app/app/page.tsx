import Link from "next/link";
import { ArrowIcon, CalendarIcon, ClockIcon, FireIcon, SparkIcon, TrophyIcon, WalletIcon } from "@/components/icons";
import { StatusPill } from "@/components/status-pill";
import { requireActiveProfile } from "@/lib/auth";
import { asNumber, currency, daysUntil, monthLabel } from "@/lib/format";

type MemberRelation = { id: string; name: string; initials: string; color_key: string } | null;

function dashboardMonth() {
  const now = new Date();
  const firstConfigured = new Date("2026-08-01T00:00:00");
  const date = now < firstConfigured ? firstConfigured : new Date(now.getFullYear(), now.getMonth(), 1);
  return date.toISOString().slice(0, 10);
}

export default async function DashboardPage() {
  const { profile, supabase } = await requireActiveProfile();
  const refMonth = dashboardMonth();
  const start = new Date(refMonth);
  const next = new Date(start);
  next.setMonth(next.getMonth() + 1);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [expenseResult, walletResult, membersResult, logsResult, choresResult] = await Promise.all([
    supabase.from("expenses").select("id,title,category,due_date,amount,status,estimated,expense_shares(id,amount,payment_status,member:household_members(id,name,initials,color_key))").eq("household_id", profile.household_id).eq("reference_month", refMonth).order("due_date", { ascending: true, nullsFirst: false }),
    supabase.from("wallet_snapshots").select("balance,source,observed_at").eq("household_id", profile.household_id).order("observed_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("household_members").select("id,name,initials,color_key").eq("household_id", profile.household_id).eq("active", true).order("display_order"),
    supabase.from("chore_logs").select("id,member_id,points_awarded,reference_date,completed_at,chore:chores(title)").gte("reference_date", weekAgo.toISOString().slice(0, 10)).order("completed_at", { ascending: false }),
    supabase.from("chores").select("id,title,points,frequency").eq("household_id", profile.household_id).eq("active", true).limit(5)
  ]);

  const expenses = expenseResult.data ?? [];
  const members = membersResult.data ?? [];
  const logs = logsResult.data ?? [];
  const total = expenses.reduce((sum, expense) => sum + asNumber(expense.amount), 0);
  const allShares = expenses.flatMap((expense) => expense.expense_shares ?? []);
  const received = allShares.filter((share) => share.payment_status === "paid").reduce((sum, share) => sum + asNumber(share.amount), 0);
  const pendingPeople = new Set(allShares.filter((share) => share.payment_status !== "paid" && share.payment_status !== "waived").map((share) => {
    const member = (Array.isArray(share.member) ? share.member[0] : share.member) as MemberRelation;
    return member?.id;
  }).filter(Boolean)).size;
  const alerts = expenses.filter((expense) => {
    const days = daysUntil(expense.due_date);
    return days !== null && days <= 5 && expense.status !== "paid" && expense.status !== "cancelled";
  });
  const progress = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  const points = new Map<string, number>();
  logs.forEach((log) => points.set(log.member_id, (points.get(log.member_id) ?? 0) + log.points_awarded));
  const leaderboard = members.map((member) => ({ ...member, points: points.get(member.id) ?? 0 })).sort((a, b) => b.points - a.points);
  const activeDays = new Set(logs.map((log) => log.reference_date)).size;

  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">Visão geral • {monthLabel.format(start)}</span><h1>Bom dia, {profile.full_name.split(" ")[0]}.</h1><p>Acompanhe o que vence, o que já entrou e como está a rotina do apartamento.</p></div>
        {profile.role === "admin" && <div className="page-actions"><Link className="button secondary" href="/app/limpeza"><SparkIcon/> Registrar limpeza</Link><Link className="button primary" href={`/app/despesas?month=${refMonth.slice(0,7)}&novo=1`}><WalletIcon/> Nova despesa</Link></div>}
      </div>

      <div className="grid cols-4">
        <div className="card metric-card"><div className="metric-top"><span>Gastos do mês</span><span className="metric-icon"><WalletIcon/></span></div><strong className="metric-value">{currency.format(total)}</strong><span className="metric-foot">{expenses.length} contas e compras</span></div>
        <div className="card metric-card"><div className="metric-top"><span>Já confirmado</span><span className="metric-icon"><ArrowIcon/></span></div><strong className="metric-value">{currency.format(received)}</strong><span className="metric-foot good">{progress}% arrecadado</span></div>
        <div className="card metric-card"><div className="metric-top"><span>Saldo Mercado Pago</span><span className="metric-icon"><WalletIcon/></span></div><strong className="metric-value">{walletResult.data ? currency.format(asNumber(walletResult.data.balance)) : "Não sincronizado"}</strong><span className="metric-foot">{walletResult.data ? `Atualizado em ${new Date(walletResult.data.observed_at).toLocaleDateString("pt-BR")}` : "Configure o token em Configurações"}</span></div>
        <div className="card metric-card"><div className="metric-top"><span>Pendências</span><span className="metric-icon"><ClockIcon/></span></div><strong className="metric-value">{pendingPeople}</strong><span className="metric-foot warn">moradores com valores em aberto</span></div>
      </div>

      <div className="dashboard-grid">
        <section className="card">
          <div className="card-head"><div><h2>Contas e despesas</h2><span className="muted-text" style={{ fontSize: 10 }}>Progresso de pagamento deste mês</span></div><Link href={`/app/despesas?month=${refMonth.slice(0,7)}`} className="button ghost small">Ver todas <ArrowIcon/></Link></div>
          <div style={{ padding: "18px 20px 8px" }}><div className="progress-track"><span style={{ width: `${progress}%` }}/></div><div className="progress-label"><span>{currency.format(received)} recebidos</span><span>{currency.format(Math.max(0,total-received))} pendentes</span></div></div>
          <div className="list">
            {expenses.slice(0,6).map((expense) => {
              const paid = (expense.expense_shares ?? []).filter((share) => share.payment_status === "paid").length;
              const totalShares = expense.expense_shares?.length ?? 0;
              return <div className="list-row" key={expense.id}><div className="item-title"><strong>{expense.title}</strong><small>{expense.category}{expense.estimated ? " • valor estimado" : ""}</small></div><div className="item-value"><strong>{expense.amount === null ? "A definir" : currency.format(asNumber(expense.amount))}</strong><small>{paid}/{totalShares} pagamentos</small></div><div className="item-value"><strong>{expense.due_date ? new Date(`${expense.due_date}T00:00:00`).toLocaleDateString("pt-BR") : "Sem data"}</strong><small>vencimento</small></div><StatusPill status={expense.status}/></div>;
            })}
            {expenses.length === 0 && <div className="empty">Nenhuma despesa cadastrada para o período.</div>}
          </div>
        </section>

        <div className="grid">
          <section className="card pad">
            <div className="card-head" style={{ padding: 0, paddingBottom: 15, marginBottom: 15 }}><h3>Alertas próximos</h3><CalendarIcon/></div>
            <div className="alert-list">
              {alerts.slice(0,4).map((expense) => {
                const days = daysUntil(expense.due_date) ?? 0;
                return <div className="alert-item" key={expense.id}><span className={`alert-dot ${days < 0 ? "red" : ""}`}/><div><strong>{expense.title}</strong><small>{days < 0 ? `${Math.abs(days)} dia(s) em atraso` : days === 0 ? "Vence hoje" : `Vence em ${days} dia(s)`} • {expense.amount === null ? "valor a definir" : currency.format(asNumber(expense.amount))}</small></div></div>;
              })}
              {alerts.length === 0 && <div className="empty" style={{ padding: 12 }}>Nenhum vencimento urgente.</div>}
            </div>
          </section>

          <section className="card pad streak-card">
            <div className="metric-top"><span>Casa em dia</span><FireIcon/></div>
            <div className="streak-value"><FireIcon/><div><strong>{activeDays}</strong><small>dias ativos nesta semana</small></div></div>
          </section>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="card">
          <div className="card-head"><div><h2>Rotina da casa</h2><span className="muted-text" style={{ fontSize: 10 }}>Últimas atividades registradas</span></div><Link href="/app/limpeza" className="button ghost small">Abrir rotina <ArrowIcon/></Link></div>
          <div className="list">
            {logs.slice(0,5).map((log) => {
              const member = members.find((item) => item.id === log.member_id);
              const chore = Array.isArray(log.chore) ? log.chore[0] : log.chore;
              return <div className="list-row" key={log.id}><div className="item-title"><strong>{chore?.title ?? "Tarefa concluída"}</strong><small>{member?.name ?? "Morador"}</small></div><div className="item-value"><strong>+{log.points_awarded} pts</strong><small>pontuação</small></div><div className="item-value"><strong>{new Date(log.completed_at).toLocaleDateString("pt-BR")}</strong><small>conclusão</small></div><StatusPill status="paid"/></div>;
            })}
            {logs.length === 0 && <div className="empty">Ainda não há atividades registradas nesta semana.</div>}
          </div>
        </section>
        <section className="card pad">
          <div className="card-head" style={{ padding: 0, paddingBottom: 15, marginBottom: 15 }}><h3>Ranking semanal</h3><TrophyIcon/></div>
          <div className="leaderboard">{leaderboard.map((member,index) => <div className="leader-row" key={member.id}><div className="leader-rank">{index+1}</div><div className="leader-person"><div className={`avatar avatar-${member.color_key}`}>{member.initials}</div><div><strong>{member.name}</strong><small>{index === 0 && member.points > 0 ? "Líder da semana" : "Morador"}</small></div></div><div className="leader-points"><strong>{member.points}</strong><small>pontos</small></div></div>)}</div>
        </section>
      </div>
    </>
  );
}
