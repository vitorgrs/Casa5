import { CasaEmDiaTabs } from "@/components/casa-em-dia-tabs";
import { HomeIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import {
  deriveHouseCleaningTurn,
  HOUSE_CLEANING_AREA_DEFINITIONS,
  isHouseCleaningMode,
  type HouseCleaningMode,
  type HouseCleaningMember,
} from "@/lib/house-cleaning";
import {
  InteractiveHouseMap,
  type HouseMapArea,
  type HouseMapStove,
} from "./interactive-house-map";

export const dynamic = "force-dynamic";

type AreaRow = {
  id: string;
  slug: string;
  name: string;
  display_order: number;
  people_per_turn: number;
  allow_incomplete_last_group: boolean;
  cleaning_mode: HouseCleaningMode;
  min_cleaners: number;
  max_cleaners: number;
  suggested_member_ids: string[] | null;
  current_start_member_id: string | null;
  current_since: string | null;
  turn_number: number | string | null;
};

type RotationRow = {
  area_id: string;
  member_id: string;
  rotation_order: number;
};

type HistoryRow = {
  id: string;
  area_id: string;
  member_ids_snapshot: string[] | null;
  member_names_snapshot: string[] | null;
  next_member_ids_snapshot: string[] | null;
  next_member_names_snapshot: string[] | null;
  cleaned_on: string;
  cleaned_at: string;
  note: string | null;
};

function isPositiveTurn(value: number | string | null | undefined) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }
  return typeof value === "string" && /^\d+$/.test(value) && value !== "0";
}

export default async function InteractiveHouseMapPage() {
  const { profile, supabase } = await requireActiveProfile();

  const [
    membersResult,
    areasResult,
    rotationResult,
    stoveSettingsResult,
    stoveRotationResult,
    stoveHistoryResult,
  ] = await Promise.all([
    supabase
      .from("household_members")
      .select("id,name,initials,color_key,display_order")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
    supabase
      .from("house_cleaning_areas")
      .select("*")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
    supabase
      .from("house_cleaning_rotation_members")
      .select("area_id,member_id,rotation_order")
      .eq("household_id", profile.household_id)
      .order("rotation_order"),
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

  const members = (membersResult.data ?? []).map((member) => ({
    id: member.id,
    name: member.name,
    initials: member.initials,
    color_key: member.color_key,
  })) as HouseCleaningMember[];
  const memberById = new Map(members.map((member) => [member.id, member]));

  const configuredAreas = (areasResult.data ?? []) as AreaRow[];
  const rulesMigrationReady =
    configuredAreas.length === 0 ||
    configuredAreas.every(
      (area) =>
        isHouseCleaningMode(area.cleaning_mode) &&
        (area.min_cleaners === 1 || area.min_cleaners === 2) &&
        (area.max_cleaners === 1 || area.max_cleaners === 2),
    );
  const historyResults = await Promise.all(
    configuredAreas.map((area) =>
      supabase
        .from("house_cleaning_history")
        .select(
          "id,area_id,member_ids_snapshot,member_names_snapshot,next_member_ids_snapshot,next_member_names_snapshot,cleaned_on,cleaned_at,note",
        )
        .eq("household_id", profile.household_id)
        .eq("area_id", area.id)
        .order("cleaned_on", { ascending: false })
        .order("cleaned_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(12),
    ),
  );
  const areaBySlug = new Map(configuredAreas.map((area) => [area.slug, area]));
  const rotationRows = (rotationResult.data ?? []) as RotationRow[];
  const historyRows = historyResults.flatMap(
    (result) => (result.data ?? []) as HistoryRow[],
  );
  const historyLoadError = historyResults.some((result) => result.error);

  const areas: HouseMapArea[] = HOUSE_CLEANING_AREA_DEFINITIONS.map(
    (definition) => {
      const row = areaBySlug.get(definition.slug);
      const rawRotationRows = row
        ? rotationRows.filter((rotation) => rotation.area_id === row.id)
        : [];
      const rotationMembers = rawRotationRows.reduce<HouseCleaningMember[]>(
        (ordered, rotation) => {
          const member = memberById.get(rotation.member_id);
          if (member) ordered.push(member);
          return ordered;
        },
        [],
      );
      const peoplePerTurn: 1 | 2 = row?.people_per_turn === 1 ? 1 : 2;
      const allowIncomplete = row?.allow_incomplete_last_group ?? true;
      const cleaningMode = isHouseCleaningMode(row?.cleaning_mode)
        ? row.cleaning_mode
        : "round_robin";
      const minCleaners: 1 | 2 = row?.min_cleaners === 2 ? 2 : 1;
      const maxCleaners: 1 | 2 = row?.max_cleaners === 1 ? 1 : 2;
      const currentStartMemberId = row?.current_start_member_id ?? null;
      const roundRobinTurn = deriveHouseCleaningTurn(
        rotationMembers,
        peoplePerTurn,
        allowIncomplete,
        currentStartMemberId,
      );
      const suggestedMembers = (row?.suggested_member_ids ?? []).reduce<
        HouseCleaningMember[]
      >((selected, memberId) => {
        const member = memberById.get(memberId);
        if (
          member &&
          rotationMembers.some((candidate) => candidate.id === member.id) &&
          !selected.some((candidate) => candidate.id === member.id)
        ) {
          selected.push(member);
        }
        return selected;
      }, []);
      const currentMembers =
        cleaningMode === "round_robin"
          ? roundRobinTurn.currentMembers
          : cleaningMode === "fixed"
            ? rotationMembers.slice(0, maxCleaners)
            : suggestedMembers;
      const nextMembers =
        cleaningMode === "round_robin"
          ? roundRobinTurn.nextMembers
          : suggestedMembers;
      const currentIndex = rotationMembers.findIndex(
        (member) => member.id === currentStartMemberId,
      );
      const startsValidGroup =
        !allowIncomplete ||
        (currentIndex >= 0 && currentIndex % peoplePerTurn === 0);
      const baseConfigurationReady = Boolean(
        row &&
          rotationMembers.length > 0 &&
          rotationMembers.length === rawRotationRows.length &&
          minCleaners <= maxCleaners &&
          maxCleaners <= rotationMembers.length &&
          isPositiveTurn(row.turn_number),
      );
      const configurationReady =
        baseConfigurationReady &&
        (cleaningMode !== "round_robin" ||
          Boolean(
            (row?.people_per_turn === 1 || row?.people_per_turn === 2) &&
              peoplePerTurn <= rotationMembers.length &&
              currentStartMemberId &&
              startsValidGroup &&
              currentMembers.length > 0,
          )) &&
        (cleaningMode !== "balanced" ||
          (suggestedMembers.length >= minCleaners &&
            suggestedMembers.length <= maxCleaners));

      return {
        id: row?.id ?? definition.slug,
        slug: definition.slug,
        name: definition.name,
        order: definition.order,
        peoplePerTurn,
        allowIncomplete,
        cleaningMode,
        minCleaners,
        maxCleaners,
        currentStartMemberId,
        currentSince: row?.current_since ?? null,
        turnNumber: row?.turn_number ?? null,
        rotationMembers,
        suggestedMembers,
        currentMembers: configurationReady ? currentMembers : [],
        nextMembers: configurationReady ? nextMembers : [],
        history: row
          ? historyRows
              .filter((entry) => entry.area_id === row.id)
              .slice(0, 12)
              .map((entry) => ({
                id: entry.id,
                memberIdsSnapshot: entry.member_ids_snapshot ?? [],
                memberNamesSnapshot: entry.member_names_snapshot ?? [],
                nextMemberIdsSnapshot: entry.next_member_ids_snapshot ?? [],
                nextMemberNamesSnapshot: entry.next_member_names_snapshot ?? [],
                cleanedOn: entry.cleaned_on,
                cleanedAt: entry.cleaned_at,
                note: entry.note,
              }))
          : [],
        configurationReady,
      };
    },
  );

  const stoveRotationRows = stoveRotationResult.data ?? [];
  const stoveMembers = stoveRotationRows.reduce<HouseCleaningMember[]>(
    (ordered, rotation) => {
      const member = memberById.get(rotation.member_id);
      if (member) ordered.push(member);
      return ordered;
    },
    [],
  );
  const stoveMemberIds = new Set(stoveMembers.map((member) => member.id));
  const stoveSettings = stoveSettingsResult.data;
  const stoveConfigurationReady = Boolean(
    stoveMembers.length >= 2 &&
      stoveMembers.length === stoveRotationRows.length &&
      stoveSettings?.current_member_id &&
      stoveMemberIds.has(stoveSettings.current_member_id) &&
      isPositiveTurn(stoveSettings?.turn_number),
  );
  const stove: HouseMapStove = {
    members: stoveMembers,
    currentMemberId: stoveSettings?.current_member_id ?? null,
    currentSince: stoveSettings?.current_since ?? null,
    currentTurnNumber: stoveSettings?.turn_number ?? null,
    history: (stoveHistoryResult.data ?? []).map((entry) => ({
      id: entry.id,
      memberId: entry.member_id,
      memberNameSnapshot: entry.member_name_snapshot,
      cleanedAt: entry.cleaned_at,
      nextMemberId: entry.next_member_id,
      nextMemberNameSnapshot: entry.next_member_name_snapshot,
      note: entry.note,
    })),
    configurationReady: stoveConfigurationReady,
  };

  const loadError = [
    membersResult.error,
    areasResult.error,
    rotationResult.error,
    historyLoadError,
    stoveSettingsResult.error,
    stoveRotationResult.error,
    stoveHistoryResult.error,
  ].some(Boolean)
    ? "Não foi possível carregar todas as informações de limpeza. O mapa foi mantido disponível com os dados que já puderam ser lidos; atualize a página depois de aplicar as migrations."
    : !rulesMigrationReady
      ? "O mapa já está disponível. Aplique a migration 033 para ativar as novas regras e os registros por participante."
      : null;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia • Mapa interativo</span>
          <h1>Mapa de limpeza da casa</h1>
          <p>
            Selecione um cômodo para ver quem limpou por último, confirmar uma
            limpeza e acompanhar a próxima equipe do rodízio.
          </p>
        </div>
        <div className="role-chip">
          <HomeIcon /> Rodízio por cômodo
        </div>
      </div>

      <CasaEmDiaTabs active="mapa" />

      <InteractiveHouseMap
        members={members}
        areas={areas}
        stove={stove}
        canManage={profile.role === "admin"}
        currentMemberId={profile.member_id}
        houseMutationsReady={
          !membersResult.error &&
          !areasResult.error &&
          !rotationResult.error &&
          rulesMigrationReady
        }
        stoveMutationsReady={
          !membersResult.error &&
          !stoveSettingsResult.error &&
          !stoveRotationResult.error
        }
        loadError={loadError}
      />
    </>
  );
}
