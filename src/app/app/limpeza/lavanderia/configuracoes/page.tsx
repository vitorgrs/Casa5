import Link from "next/link";
import { ArrowIcon, LaundryIcon, SettingsIcon } from "@/components/icons";
import { requireAdmin } from "@/lib/auth";
import { addDays, formatHouseDate, todayIso } from "@/lib/chore-rotation";
import {
  laundryAssignmentsForDate,
  laundryItemLabel,
  type LaundryRotationMember,
  type LaundryRotationOverride,
  type LaundryRotationVersion,
} from "@/lib/laundry-rotation";
import {
  CollectiveWashCreateForm,
  CollectiveWashDeleteForm,
} from "./collective-wash-forms";
import { LaundryRotationEditor } from "./laundry-rotation-editor";

export const dynamic = "force-dynamic";

export default async function LaundrySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string; updated?: string }>;
}) {
  const params = await searchParams;
  const { profile, supabase } = await requireAdmin();
  const today = todayIso();
  const [
    { data: versionRows },
    { data: versionMemberRows },
    { data: overrideRows },
    { data: members },
    { data: washes },
  ] =
    await Promise.all([
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
        .from("laundry_rotation_overrides")
        .select("wash_date,member_id,resets_rotation,note,created_at")
        .eq("household_id", profile.household_id),
      supabase
        .from("household_members")
        .select("id,name,initials,color_key,display_order,active")
        .eq("household_id", profile.household_id)
        .order("display_order"),
      supabase
        .from("laundry_collective_washes")
        .select("id,wash_date,item_type,custom_label,note,responsible_member_id")
        .eq("household_id", profile.household_id)
        .gte("wash_date", todayIso())
        .order("wash_date")
        .limit(30),
    ]);

  const memberRowsByVersion = new Map<string, LaundryRotationMember[]>();
  for (const row of versionMemberRows ?? []) {
    const current = memberRowsByVersion.get(row.version_id) ?? [];
    current.push({
      id: row.member_id,
      name: row.member_name,
      initials: row.member_initials,
      color_key: row.member_color_key,
      rotation_order: row.rotation_order,
    });
    memberRowsByVersion.set(row.version_id, current);
  }
  const versions: LaundryRotationVersion[] = (versionRows ?? []).map((version) => ({
    ...version,
    members: (memberRowsByVersion.get(version.id) ?? []).sort(
      (first, second) => first.rotation_order - second.rotation_order,
    ),
  }));
  const overrides = (overrideRows ?? []) as LaundryRotationOverride[];
  const currentVersion = versions
    .filter((version) => version.effective_from <= today)
    .at(-1) ?? versions[0] ?? null;
  const currentOrder = new Map(
    (currentVersion?.members ?? []).map((member) => [member.id, member.rotation_order]),
  );
  const activeMembers = (members ?? []).filter((member) => member.active);
  const orderedMembers = [...activeMembers].sort(
    (first, second) =>
      (currentOrder.get(first.id) ?? first.display_order) -
      (currentOrder.get(second.id) ?? second.display_order),
  );
  const memberNames = new Map(
    (members ?? []).map((member) => [member.id, member.name]),
  );
  let defaultAnchorDate = today;
  let defaultAnchorMember = orderedMembers[0]?.id ?? "";
  if (currentVersion) {
    const nextResetDate = overrides
      .filter(
        (override) => override.resets_rotation && override.wash_date >= today,
      )
      .sort((first, second) => first.wash_date.localeCompare(second.wash_date))[0]
      ?.wash_date;
    const scheduledStart = currentVersion.anchor_date > today
      ? currentVersion.anchor_date
      : today;
    const scanStart =
      nextResetDate && nextResetDate < scheduledStart
        ? nextResetDate
        : scheduledStart;
    for (let offset = 0; offset <= currentVersion.gap_days + 1; offset += 1) {
      const candidateDate = addDays(scanStart, offset);
      const assignment = laundryAssignmentsForDate(
        candidateDate,
        versions,
        overrides,
      );
      const firstActiveMember = assignment?.members.find((assigned) =>
        orderedMembers.some((member) => member.id === assigned.id),
      );
      if (firstActiveMember) {
        defaultAnchorDate = candidateDate;
        defaultAnchorMember = firstActiveMember.id;
        break;
      }
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Administração • Lavanderia</span>
          <h1>Configurar calendário de lavagem</h1>
          <p>
            Defina os grupos, o intervalo e as lavagens coletivas sem reescrever
            nenhuma data anterior.
          </p>
        </div>
        <div className="page-actions">
          <Link className="button ghost" href="/app/limpeza/lavanderia">
            <ArrowIcon /> Voltar ao calendário
          </Link>
        </div>
      </div>

      {params.success && <div className="message success">{params.success}</div>}
      {params.error && <div className="message error">{params.error}</div>}

      <div className="laundry-admin-grid">
        <section className="card pad">
          <div className="card-head laundry-card-head">
            <div>
              <h2>Rodízio dos moradores</h2>
              <span className="muted-text">
                Salvar substitui a escala de hoje em diante; a data escolhida será
                a primeira lavagem e o histórico ficará intacto.
              </span>
            </div>
            <SettingsIcon />
          </div>
          <LaundryRotationEditor
            initialMembers={orderedMembers.map((member) => ({
              id: member.id,
              name: member.name,
              initials: member.initials,
              color_key: member.color_key,
            }))}
            anchorDate={defaultAnchorDate}
            anchorMemberId={defaultAnchorMember}
            gapDays={currentVersion?.gap_days ?? 2}
            peoplePerDay={currentVersion?.people_per_day ?? 2}
            allowIncompleteLastGroup={
              currentVersion?.allow_incomplete_last_group ?? true
            }
          />
        </section>

        <section className="card pad">
          <div className="card-head laundry-card-head">
            <div>
              <h2>Adicionar lavagem coletiva</h2>
              <span className="muted-text">Reserve uma data para outros itens da casa.</span>
            </div>
            <LaundryIcon />
          </div>
          <CollectiveWashCreateForm
            minDate={todayIso()}
            members={orderedMembers.map((member) => ({
              id: member.id,
              name: member.name,
            }))}
          />
        </section>
      </div>

      <section className="card laundry-upcoming-card">
        <div className="card-head">
          <div>
            <h2>Próximas lavagens coletivas</h2>
            <span className="muted-text">Itens cadastrados manualmente pelo administrador.</span>
          </div>
          <span className="status-pill violet">{washes?.length ?? 0}</span>
        </div>
        <div className="laundry-upcoming-list">
          {(washes ?? []).map((wash) => (
            <div className="laundry-upcoming-row" key={wash.id}>
              <div>
                <strong>{laundryItemLabel(wash.item_type, wash.custom_label)}</strong>
                <small>
                  {formatHouseDate(wash.wash_date)}
                  {wash.responsible_member_id
                    ? ` • Responsável: ${memberNames.get(wash.responsible_member_id) ?? "Morador não encontrado"}`
                    : ""}
                  {wash.note ? ` • ${wash.note}` : ""}
                </small>
              </div>
              <CollectiveWashDeleteForm washId={wash.id} />
            </div>
          ))}
          {(washes?.length ?? 0) === 0 && (
            <div className="empty">Nenhuma lavagem coletiva futura cadastrada.</div>
          )}
        </div>
      </section>
    </>
  );
}
