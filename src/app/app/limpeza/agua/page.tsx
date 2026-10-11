import { CasaEmDiaTabs } from "@/components/casa-em-dia-tabs";
import { WaterIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import {
  WaterGallonManager,
  type WaterGallonPayment,
  type WaterGallonSuggestion,
} from "../water-gallon-manager";

export const dynamic = "force-dynamic";

export default async function WaterGallonPage() {
  const { profile, supabase } = await requireActiveProfile();

  const [
    { data: members, error: membersError },
    { data: settings, error: settingsError },
    { data: rotationRows, error: rotationError },
    { data: payments, error: paymentsError },
    { data: suggestions, error: suggestionsError },
  ] = await Promise.all([
    supabase
      .from("household_members")
      .select("id,name,initials,color_key,display_order")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
    supabase
      .from("water_gallon_rotation_settings")
      .select("current_member_id,current_since,updated_at")
      .eq("household_id", profile.household_id)
      .maybeSingle(),
    supabase
      .from("water_gallon_rotation_members")
      .select("member_id,rotation_order")
      .eq("household_id", profile.household_id)
      .order("rotation_order"),
    supabase
      .from("water_gallon_payments")
      .select(
        "id,member_id,member_name_snapshot,paid_on,source,purchase_id,next_member_id,next_member_name_snapshot,note",
      )
      .eq("household_id", profile.household_id)
      .order("paid_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(12),
    supabase.rpc("get_water_gallon_purchase_suggestions"),
  ]);

  const orderByMember = new Map(
    (rotationRows ?? []).map((row) => [row.member_id, row.rotation_order]),
  );
  const rotationMembers = (members ?? [])
    .map((member) => ({
      id: member.id,
      name: member.name,
      initials: member.initials,
      color_key: member.color_key,
      rotation_order: orderByMember.get(member.id) ?? member.display_order,
    }))
    .sort((first, second) => first.rotation_order - second.rotation_order);
  const activeMemberIds = new Set((members ?? []).map((member) => member.id));
  const configuredMemberIds = new Set(
    (rotationRows ?? [])
      .map((row) => row.member_id)
      .filter((memberId) => activeMemberIds.has(memberId)),
  );
  const configurationReady = Boolean(
    settings?.current_member_id &&
      activeMemberIds.has(settings.current_member_id) &&
      configuredMemberIds.size === activeMemberIds.size &&
      (rotationRows ?? []).length === activeMemberIds.size,
  );
  const loadError = [
    membersError,
    settingsError,
    rotationError,
    paymentsError,
    suggestionsError,
  ].find(Boolean);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia • Galão de água</span>
          <h1>Pagamento do galão</h1>
          <p>
            Veja de quem é a vez, confirme um pagamento e ajuste a ordem do
            rodízio quando necessário.
          </p>
        </div>
        <div className="role-chip">
          <WaterIcon /> Rodízio por pagamento
        </div>
      </div>

      <CasaEmDiaTabs active="agua" />

      <WaterGallonManager
        initialMembers={rotationMembers.map(
          ({ rotation_order: _rotationOrder, ...member }) => member,
        )}
        currentMemberId={settings?.current_member_id ?? null}
        currentSince={settings?.current_since ?? null}
        suggestions={(suggestions ?? []) as WaterGallonSuggestion[]}
        payments={(payments ?? []) as WaterGallonPayment[]}
        canManage={profile.role === "admin"}
        configurationReady={configurationReady}
        loadError={
          loadError
            ? "Não foi possível carregar todas as informações do rodízio de água. Atualize a página e tente novamente."
            : null
        }
      />
    </>
  );
}
