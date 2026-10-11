import Link from "next/link";
import {
  ArrowIcon,
  CalendarIcon,
  ClockIcon,
  LaundryIcon,
  WalletIcon,
  WaterIcon,
} from "@/components/icons";
import { StatusPill } from "@/components/status-pill";
import { can, requireActiveProfile } from "@/lib/auth";
import {
  addDays,
  formatHouseDate,
  rotationMemberForDate,
  todayIso,
  type RotationMember,
  type RotationSwap,
} from "@/lib/chore-rotation";
import { asNumber, currency, daysUntil, monthLabel } from "@/lib/format";
import {
  laundryAssignmentsForDate,
  laundryDryingAssignmentsForDate,
  laundryMemberNames,
  type LaundryAssignment,
  type LaundryRotationMember,
  type LaundryRotationOverride,
  type LaundryRotationVersion,
} from "@/lib/laundry-rotation";

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
    waterSettingsResult,
    laundryVersionsResult,
    laundryVersionMembersResult,
    laundryOverridesResult,
  ] = await Promise.all([
    supabase
      .from("expenses")
      .select(
        "id,title,category,due_date,amount,status,estimated,expense_shares(id,amount,paid_amount,payment_status,member:household_members(id,name,initials,color_key))",
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
    supabase
      .from("water_gallon_rotation_settings")
      .select("current_member_id,current_since")
      .eq("household_id", profile.household_id)
      .maybeSingle(),
    supabase
      .from("laundry_rotation_versions")
      .select(
        "id,effective_from,anchor_date,anchor_member_id,gap_days,people_per_day,allow_incomplete_last_group,created_at",
      )
      .eq("household_id", profile.household_id)
      .order("effective_from"),
    supabase
      .from("laundry_rotation_version_members")
      .select(
        "version_id,member_id,rotation_order,member_name,member_initials,member_color_key",
      )
      .eq("household_id", profile.household_id)
      .order("rotation_order"),
    supabase
      .from("laundry_rotation_overrides")
      .select("wash_date,member_id,resets_rotation,note,created_at")
      .eq("household_id", profile.household_id)
      .order("wash_date"),
  ]);

  const expenses = expenseResult.data ?? [];
  const members = membersResult.data ?? [];
  const total = expenses.reduce((sum, expense) => sum + asNumber(expense.amount), 0);
  const allShares = expenses.flatMap((expense) => expense.expense_shares ?? []);
  const received = allShares
    .filter((share) => share.payment_status === "paid")
    .reduce(
      (sum, share) => sum + asNumber(share.paid_amount ?? share.amount),
      0,
    );
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
  const todayDuty = rotationMemberForDate(
    today,
    settingsResult.data?.start_date ?? null,
    rotationMembers,
    swaps,
  );
  const waterMember = members.find(
    (member) => member.id === waterSettingsResult.data?.current_member_id,
  ) ?? null;

  const knownLaundryMembers: LaundryRotationMember[] = members.map((member) => ({
    id: member.id,
    name: member.name,
    initials: member.initials,
    color_key: member.color_key,
    rotation_order: member.display_order,
  }));
  const knownLaundryMemberById = new Map(
    knownLaundryMembers.map((member) => [member.id, member]),
  );
  const laundryMembersByVersion = new Map<string, LaundryRotationMember[]>();
  for (const row of laundryVersionMembersResult.data ?? []) {
    const fallback = knownLaundryMemberById.get(row.member_id);
    const versionMembers = laundryMembersByVersion.get(row.version_id) ?? [];
    versionMembers.push({
      id: row.member_id,
      name: row.member_name || fallback?.name || "Morador",
      initials: row.member_initials || fallback?.initials || "?",
      color_key: row.member_color_key || fallback?.color_key || "violet",
      rotation_order: row.rotation_order,
    });
    laundryMembersByVersion.set(row.version_id, versionMembers);
  }
  const laundryVersions: LaundryRotationVersion[] = (
    laundryVersionsResult.data ?? []
  ).map((version) => ({
    ...version,
    members: (laundryMembersByVersion.get(version.id) ?? []).sort(
      (first, second) => first.rotation_order - second.rotation_order,
    ),
  }));
  const laundryOverrides = (
    laundryOverridesResult.data ?? []
  ) as LaundryRotationOverride[];
  const todayLaundry = laundryAssignmentsForDate(
    today,
    laundryVersions,
    laundryOverrides,
    knownLaundryMembers,
  );
  const currentDrying = laundryDryingAssignmentsForDate(
    today,
    laundryVersions,
    laundryOverrides,
    knownLaundryMembers,
  )[0] ?? null;
  let nextLaundry: { date: string; assignment: LaundryAssignment } | null = null;
  for (let offset = todayLaundry ? 1 : 0; offset <= 370; offset += 1) {
    const date = addDays(today, offset);
    const assignment = laundryAssignmentsForDate(
      date,
      laundryVersions,
      laundryOverrides,
      knownLaundryMembers,
    );
    if (assignment) {
      nextLaundry = { date, assignment };
      break;
    }
  }
  const dryingGapDays =
    todayLaundry?.version?.gap_days ?? currentDrying?.version?.gap_days ?? 0;
  const dryingDaysAfterToday = currentDrying
    ? Math.max(0, dryingGapDays - currentDrying.dryingDay)
    : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Visão geral • {monthLabel.format(monthDate)}</span>
          <h1>Bom dia, {profile.full_name.split(" ")[0]}.</h1>
          <p>Acompanhe o que vence, o que já entrou e quem cuida da rotina da casa hoje.</p>
        </div>
        <div className="page-actions">
          <Link className="button ghost" href="/app/eu">Minha página</Link>
          <Link className="button secondary" href="/app/limpeza">
            <CalendarIcon /> Casa em dia
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
                ? walletResult.data.source === "mercado_pago"
                  ? `Saldo referente a ${new Date(walletResult.data.observed_at).toLocaleDateString("pt-BR")}`
                  : `Informado em ${new Date(walletResult.data.observed_at).toLocaleDateString("pt-BR")}`
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

        </div>
      </div>

      <section className="card home-status-section">
        <div className="card-head">
          <div>
            <h2>Casa em dia hoje</h2>
            <span className="muted-text">Somente o estado atual de cada rodízio.</span>
          </div>
          <Link href="/app/limpeza" className="button ghost small">
            Abrir Casa em dia <ArrowIcon />
          </Link>
        </div>

        <div className="home-status-grid">
          <article className="home-status-card">
            <div className="home-status-title">
              <span className="metric-icon"><CalendarIcon /></span>
              <div>
                <span>Tarefas do dia</span>
                <small>Responsável de hoje</small>
              </div>
            </div>
            {todayDuty ? (
              <div className="home-status-person">
                <div className={`avatar avatar-${todayDuty.color_key}`}>
                  {todayDuty.initials}
                </div>
                <strong>{todayDuty.name}</strong>
              </div>
            ) : (
              <div className="empty">A escala ainda não foi configurada.</div>
            )}
          </article>

          <article className="home-status-card">
            <div className="home-status-title">
              <span className="metric-icon"><LaundryIcon /></span>
              <div>
                <span>Lavanderia</span>
                <small>
                  {todayLaundry
                    ? "Lavagem de hoje"
                    : currentDrying
                      ? "Em período de secagem"
                      : "Próxima lavagem"}
                </small>
              </div>
            </div>
            {todayLaundry ? (
              <>
                <div className="home-status-person">
                  <div className="laundry-avatar-stack">
                    {todayLaundry.members.map((member) => (
                      <div className={`avatar avatar-${member.color_key}`} key={member.id}>
                        {member.initials}
                      </div>
                    ))}
                  </div>
                  <strong>{laundryMemberNames(todayLaundry.members, true)}</strong>
                </div>
                <p className="home-status-meta">
                  {dryingGapDays > 0
                    ? `${dryingGapDays} dia(s) de secagem a partir de amanhã; o dia da lavagem não entra na conta.`
                    : "Sem intervalo de secagem configurado."}
                </p>
              </>
            ) : currentDrying ? (
              <>
                <div className="home-status-person">
                  <div className="laundry-avatar-stack">
                    {currentDrying.members.map((member) => (
                      <div className={`avatar avatar-${member.color_key}`} key={member.id}>
                        {member.initials}
                      </div>
                    ))}
                  </div>
                  <strong>{laundryMemberNames(currentDrying.members, true)}</strong>
                </div>
                <p className="home-status-meta">
                  Dia {currentDrying.dryingDay} de {dryingGapDays} da secagem. {" "}
                  {dryingDaysAfterToday === 0
                    ? "A secagem termina hoje."
                    : `Ainda ${dryingDaysAfterToday === 1 ? "resta 1 dia" : `restam ${dryingDaysAfterToday} dias`} depois de hoje.`}
                  {nextLaundry
                    ? ` Próxima lavagem: ${laundryMemberNames(nextLaundry.assignment.members, true)} em ${formatHouseDate(nextLaundry.date)}.`
                    : ""}
                </p>
              </>
            ) : nextLaundry ? (
              <>
                <div className="home-status-person">
                  <div className="laundry-avatar-stack">
                    {nextLaundry.assignment.members.map((member) => (
                      <div className={`avatar avatar-${member.color_key}`} key={member.id}>
                        {member.initials}
                      </div>
                    ))}
                  </div>
                  <strong>{laundryMemberNames(nextLaundry.assignment.members, true)}</strong>
                </div>
                <p className="home-status-meta">
                  Próxima lavagem em {formatHouseDate(nextLaundry.date)}.
                </p>
              </>
            ) : (
              <div className="empty">O rodízio da lavanderia ainda não foi configurado.</div>
            )}
          </article>

          <article className="home-status-card">
            <div className="home-status-title">
              <span className="metric-icon"><WaterIcon /></span>
              <div>
                <span>Galão de água</span>
                <small>Pessoa da vez para pagar</small>
              </div>
            </div>
            {waterMember ? (
              <>
                <div className="home-status-person">
                  <div className={`avatar avatar-${waterMember.color_key}`}>
                    {waterMember.initials}
                  </div>
                  <strong>{waterMember.name}</strong>
                </div>
                {waterSettingsResult.data?.current_since && (
                  <p className="home-status-meta">
                    Na vez desde {formatHouseDate(waterSettingsResult.data.current_since)}.
                  </p>
                )}
              </>
            ) : (
              <div className="empty">O rodízio do galão ainda não foi configurado.</div>
            )}
          </article>
        </div>
      </section>
    </>
  );
}
