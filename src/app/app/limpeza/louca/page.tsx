import { CasaEmDiaTabs } from "@/components/casa-em-dia-tabs";
import { DishIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import {
  StoveCleaningManager,
  type StoveCleaningHistoryEntry,
  type StoveCleaningMember,
} from "../stove-cleaning-manager";

export const dynamic = "force-dynamic";

export default async function DishRackCleaningPage() {
  const { profile, supabase } = await requireActiveProfile();

  // A ordem vem do rodízio do fogão; pessoa da vez e histórico são próprios.
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
      .from("dish_rack_cleaning_settings")
      .select("current_member_id,current_since,turn_number")
      .eq("household_id", profile.household_id)
      .maybeSingle(),
    supabase
      .from("stove_cleaning_rotation_members")
      .select("member_id,rotation_order")
      .eq("household_id", profile.household_id)
      .order("rotation_order"),
    supabase
      .from("dish_rack_cleaning_history")
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
          <span className="eyebrow">Casa em dia • Louça</span>
          <h1>Lava-louça e seca-louça</h1>
          <p>
            Mesma ordem do rodízio do fogão. Confirme quando a pessoa da vez
            terminar a limpeza para passar a vez à próxima.
          </p>
        </div>
        <div className="role-chip">
          <DishIcon /> Rodízio por confirmação
        </div>
      </div>

      <CasaEmDiaTabs active="louca" />

      <StoveCleaningManager
        variant="dish-rack"
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
            ? "Não foi possível carregar todas as informações do rodízio do lava-louça. Confira se a migration 034 foi aplicada e atualize a página."
            : null
        }
      />
    </>
  );
}
