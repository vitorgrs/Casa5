import Link from "next/link";
import { CasaEmDiaTabs } from "@/components/casa-em-dia-tabs";
import { CalendarIcon, LaundryIcon, SettingsIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import { addDays, formatHouseDate, isIsoDate, todayIso } from "@/lib/chore-rotation";
import {
  laundryAssignmentsForDate,
  laundryDryingAssignmentsForDate,
  laundryItemLabel,
  laundryMemberNames,
  laundryVersionForDate,
  type LaundryRotationMember,
  type LaundryRotationOverride,
  type LaundryRotationVersion,
} from "@/lib/laundry-rotation";
import { LaundryDayDialog } from "./laundry-day-dialog";

export const dynamic = "force-dynamic";

function validMonth(value?: string) {
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  return todayIso().slice(0, 7);
}

function shiftMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

const weekdayShort = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const monthNames = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

export default async function LaundryCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; day?: string; success?: string; error?: string }>;
}) {
  const params = await searchParams;
  const month = validMonth(params.month);
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(`${month}-01T00:00:00.000Z`).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${pad(daysInMonth)}`;
  const selectedDay =
    isIsoDate(params.day) && params.day.startsWith(`${month}-`) ? params.day : null;
  const { profile, supabase } = await requireActiveProfile();

  const [
    { data: versionRows },
    { data: versionMemberRows },
    { data: householdMembers },
    { data: overrideRows },
    { data: collectiveRows },
  ] = await Promise.all([
    supabase
      .from("laundry_rotation_versions")
      .select("id,effective_from,anchor_date,anchor_member_id,gap_days,people_per_day,allow_incomplete_last_group,created_at")
      .eq("household_id", profile.household_id)
      .order("effective_from"),
    supabase
      .from("laundry_rotation_version_members")
      .select("version_id,member_id,rotation_order,member_name,member_initials,member_color_key")
      .eq("household_id", profile.household_id)
      .order("rotation_order"),
    supabase
      .from("household_members")
      .select("id,name,initials,color_key,display_order")
      .eq("household_id", profile.household_id)
      .order("display_order"),
    supabase
      .from("laundry_rotation_overrides")
      .select("wash_date,member_id,resets_rotation,note,created_at")
      .eq("household_id", profile.household_id)
      .lte("wash_date", monthEnd),
    supabase
      .from("laundry_collective_washes")
      .select("id,wash_date,item_type,custom_label,note,responsible_member_id")
      .eq("household_id", profile.household_id)
      .gte("wash_date", monthStart)
      .lte("wash_date", monthEnd)
      .order("wash_date"),
  ]);

  const knownMembers: LaundryRotationMember[] = (householdMembers ?? []).map(
    (member) => ({
      id: member.id,
      name: member.name,
      initials: member.initials,
      color_key: member.color_key,
      rotation_order: member.display_order,
    }),
  );
  const knownMemberById = new Map(knownMembers.map((member) => [member.id, member]));
  const versionMembersById = new Map<string, LaundryRotationMember[]>();
  for (const row of versionMemberRows ?? []) {
    const fallback = knownMemberById.get(row.member_id);
    const current = versionMembersById.get(row.version_id) ?? [];
    current.push({
      id: row.member_id,
      name: row.member_name || fallback?.name || "Morador",
      initials: row.member_initials || fallback?.initials || "?",
      color_key: row.member_color_key || fallback?.color_key || "violet",
      rotation_order: row.rotation_order,
    });
    versionMembersById.set(row.version_id, current);
  }
  const versions: LaundryRotationVersion[] = (versionRows ?? []).map((version) => ({
    ...version,
    members: (versionMembersById.get(version.id) ?? []).sort(
      (first, second) => first.rotation_order - second.rotation_order,
    ),
  }));
  const overrides = (overrideRows ?? []) as LaundryRotationOverride[];
  const collectiveByDay = new Map<string, NonNullable<typeof collectiveRows>>();
  for (const wash of collectiveRows ?? []) {
    const current = collectiveByDay.get(wash.wash_date) ?? [];
    current.push(wash);
    collectiveByDay.set(wash.wash_date, current);
  }

  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const selectedAssignment = selectedDay
    ? laundryAssignmentsForDate(selectedDay, versions, overrides, knownMembers)
    : null;
  const selectedDryings = selectedDay
    ? laundryDryingAssignmentsForDate(selectedDay, versions, overrides, knownMembers)
    : [];
  const selectedCollective = selectedDay
    ? collectiveByDay.get(selectedDay) ?? []
    : [];
  const baseRoute = `/app/limpeza/lavanderia?month=${month}`;
  const today = todayIso();
  const summaryDate = today >= monthStart && today <= monthEnd ? today : monthEnd;
  const summaryVersion = laundryVersionForDate(summaryDate, versions);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia • Lavanderia</span>
          <h1>Calendário de lavagem</h1>
          <p>
            Consulte os grupos de moradores, os períodos reservados para secagem
            e as lavagens coletivas da casa.
          </p>
        </div>
        {profile.role === "admin" && (
          <div className="page-actions">
            <Link className="button secondary" href="/app/limpeza/lavanderia/configuracoes">
              <SettingsIcon /> Configurar lavanderia
            </Link>
          </div>
        )}
      </div>

      <CasaEmDiaTabs active="lavanderia" />

      {params.success && <div className="message success">{params.success}</div>}
      {params.error && <div className="message error">{params.error}</div>}

      <div className="laundry-summary-grid">
        <section className="card pad">
          <span className="eyebrow">Pessoas por dia</span>
          <strong className="laundry-summary-value">
            {summaryVersion?.people_per_day ?? 0}
          </strong>
          <small>
            {summaryVersion?.allow_incomplete_last_group
              ? "O último grupo da rodada pode ser menor."
              : "Todos os grupos mantêm essa quantidade."}
          </small>
        </section>
        <section className="card pad">
          <span className="eyebrow">Intervalo</span>
          <strong className="laundry-summary-value">{summaryVersion?.gap_days ?? 0} dias</strong>
          <small>Dias livres para secagem entre duas lavagens de moradores.</small>
        </section>
        <section className="card pad">
          <span className="eyebrow">Sequência</span>
          <strong className="laundry-order-summary">
            {summaryVersion?.members
              .map((member) => member.name.split(" ")[0])
              .join(" → ") || "Não configurada"}
          </strong>
          <small>As regras históricas permanecem nas datas anteriores.</small>
        </section>
      </div>

      <section className="card pad laundry-calendar-card">
        <div className="month-nav rotation-month-nav">
          <Link href={`/app/limpeza/lavanderia?month=${shiftMonth(month, -1)}`} aria-label="Mês anterior">‹</Link>
          <div>
            <CalendarIcon />
            <strong>{monthNames[monthNumber - 1]} de {year}</strong>
          </div>
          <Link href={`/app/limpeza/lavanderia?month=${shiftMonth(month, 1)}`} aria-label="Próximo mês">›</Link>
        </div>

        <div className="calendar-grid laundry-calendar-grid">
          {weekdayShort.map((weekday) => (
            <div className="calendar-weekday" key={weekday}>{weekday}</div>
          ))}
          {cells.map((day, index) => {
            if (day === null) {
              return <div className="calendar-cell empty" key={`empty-${index}`} />;
            }
            const iso = `${month}-${pad(day)}`;
            const assignment = laundryAssignmentsForDate(
              iso,
              versions,
              overrides,
              knownMembers,
            );
            const dryings = laundryDryingAssignmentsForDate(
              iso,
              versions,
              overrides,
              knownMembers,
            );
            const collective = collectiveByDay.get(iso) ?? [];
            const hasContent = Boolean(assignment || dryings.length || collective.length);

            return (
              <Link
                className={`calendar-cell laundry-calendar-cell ${iso === today ? "today" : ""} ${iso === selectedDay ? "selected" : ""} ${!hasContent ? "quiet" : ""}`}
                href={`/app/limpeza/lavanderia?month=${month}&day=${iso}`}
                key={iso}
              >
                <span className="laundry-day-number">{day}</span>
                {assignment && (
                  <span className="laundry-resident-slot">
                    <span className="laundry-avatar-stack">
                      {assignment.members.map((member) => (
                        <span className={`avatar avatar-${member.color_key}`} key={member.id}>
                          {member.initials}
                        </span>
                      ))}
                    </span>
                    <strong>{laundryMemberNames(assignment.members)}</strong>
                    {assignment.source === "override" && <small>exceção</small>}
                  </span>
                )}
                {dryings.map((drying) => (
                  <span className="laundry-drying-slot" key={drying.washDate}>
                    Secagem {drying.dryingDay}/{drying.version?.gap_days ?? 0}
                    <small>{laundryMemberNames(drying.members)}</small>
                  </span>
                ))}
                {collective.length > 0 && (
                  <span className="laundry-collective-count">
                    <LaundryIcon /> {collective.length}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        <div className="laundry-legend">
          <span><b className="laundry-legend-dot resident" /> Lavagem dos moradores</span>
          <span><b className="laundry-legend-dot drying" /> Período de secagem</span>
          <span><b className="laundry-legend-dot collective" /> Lavagem coletiva</span>
        </div>
      </section>

      {selectedDay && (
        <LaundryDayDialog closeHref={baseRoute} labelledBy="laundry-day-title">
            <div className="card-head laundry-card-head">
              <div>
                <span className="eyebrow">Lavanderia</span>
                <h3 id="laundry-day-title">{formatHouseDate(selectedDay, { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}</h3>
              </div>
              <Link className="button ghost small" href={baseRoute}>Fechar</Link>
            </div>

            {selectedAssignment && (
              <div className="laundry-detail-block resident">
                <div className="laundry-avatar-stack detail">
                  {selectedAssignment.members.map((member) => (
                    <div className={`avatar avatar-${member.color_key}`} key={member.id}>
                      {member.initials}
                    </div>
                  ))}
                </div>
                <div>
                  <span>
                    {selectedAssignment.members.length === 1
                      ? "Lavagem do morador"
                      : "Lavagem dos moradores"}
                  </span>
                  <strong>{laundryMemberNames(selectedAssignment.members, true)}</strong>
                  <small>
                    Secagem reservada até {formatHouseDate(addDays(selectedDay, selectedAssignment.version?.gap_days ?? 0))}.
                  </small>
                  {selectedAssignment.note && <small>{selectedAssignment.note}</small>}
                </div>
              </div>
            )}

            {selectedDryings.map((drying) => (
              <div className="laundry-detail-block drying" key={drying.washDate}>
                <LaundryIcon />
                <div>
                  <span>Período de secagem</span>
                  <strong>Roupas de {laundryMemberNames(drying.members, true)}</strong>
                  <small>
                    Lavagem em {formatHouseDate(drying.washDate)}; secagem até {formatHouseDate(drying.dryingUntil)}.
                  </small>
                </div>
              </div>
            ))}

            {selectedCollective.map((wash) => (
              <div className="laundry-detail-block collective" key={wash.id}>
                <LaundryIcon />
                <div>
                  <span>Lavagem coletiva</span>
                  <strong>{laundryItemLabel(wash.item_type, wash.custom_label)}</strong>
                  {wash.responsible_member_id && (
                    <small>
                      Responsável: {knownMemberById.get(wash.responsible_member_id)?.name ?? "Morador não encontrado"}
                    </small>
                  )}
                  {wash.note && <small>{wash.note}</small>}
                </div>
              </div>
            ))}

            {!selectedAssignment && selectedDryings.length === 0 && selectedCollective.length === 0 && (
              <div className="empty">Nenhuma lavagem ou secagem prevista para este dia.</div>
            )}
        </LaundryDayDialog>
      )}
    </>
  );
}
