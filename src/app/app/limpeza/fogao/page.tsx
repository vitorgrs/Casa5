import { CasaEmDiaTabs } from "@/components/casa-em-dia-tabs";
import { FireIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import {
  StoveCleaningManager,
  type StoveCleaningHistoryEntry,
  type StoveCleaningMember,
} from "../stove-cleaning-manager";

export const dynamic = "force-dynamic";

export default async function StoveCleaningPage() {
  const { profile, supabase } = await requireActiveProfile();

  const [
    { data: members, error: membersError },
    { data: settings, error: settingsError },
    { data: rotationRows, error: rotationError },
    { data: history, error: historyError },
  ] = await Promise.all([
    supabase
      .from("household_members")
      .select("id,name,initials,color_key")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
    supabase
      .from("stove_cleaning_rotation_settings")
      .select("current_member_id,current_since,turn_number")
      .eq("household_id", profile.household_id)
      .maybeSingle(),
    supabase
      .from("stove_cleaning_rotation_members")
      .select("member_id,rotation_order")
      .eq("household_id", profile.household_id)
      .order("rotation_order"),
    supabase
      .from("stove_cleaning_history")
      .select(
        "id,member_id,member_name_snapshot,cleaned_at,next_member_id,next_member_name_snapshot,note",
      )
      .eq("household_id", profile.household_id)
      .order("cleaned_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(12),
  ]);

  const availableMembers = (members ?? []) as StoveCleaningMember[];
  const memberById = new Map(
    availableMembers.map((member) => [member.id, member]),
  );
  const rotationMembers = (rotationRows ?? []).reduce<StoveCleaningMember[]>(
    (ordered, row) => {
      const member = memberById.get(row.member_id);
      if (member) ordered.push(member);
      return ordered;
    },
    [],
  );
  const rotationMemberIds = new Set(rotationMembers.map((member) => member.id));
  const configurationReady = Boolean(
    rotationMembers.length >= 2 &&
      rotationMembers.length === (rotationRows ?? []).length &&
      settings?.current_member_id &&
      rotationMemberIds.has(settings.current_member_id) &&
      settings?.turn_number !== null &&
      settings?.turn_number !== undefined,
  );
  const loadError = [
    membersError,
    settingsError,
    rotationError,
    historyError,
  ].find(Boolean);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia • Fogão</span>
          <h1>Limpeza do fogão</h1>
          <p>
            Confirme quando a pessoa da vez terminar e acompanhe quem será a
            próxima, sem prazo fixo entre as limpezas.
          </p>
        </div>
        <div className="role-chip">
          <FireIcon /> Rodízio por confirmação
        </div>
      </div>

      <CasaEmDiaTabs active="fogao" />

      <StoveCleaningManager
        initialMembers={rotationMembers}
        availableMembers={availableMembers}
        currentMemberId={settings?.current_member_id ?? null}
        currentSince={settings?.current_since ?? null}
        currentTurnNumber={settings?.turn_number ?? null}
        history={(history ?? []) as StoveCleaningHistoryEntry[]}
        canManage={profile.role === "admin"}
        configurationReady={configurationReady}
        loadError={
          loadError
            ? "Não foi possível carregar todas as informações do rodízio do fogão. Atualize a página e tente novamente."
            : null
        }
      />
    </>
  );
}
