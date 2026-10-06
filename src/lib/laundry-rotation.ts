import { addDays, daysBetween } from "@/lib/chore-rotation";

export const LAUNDRY_ITEM_LABELS = {
  floor_cloths: "Panos de chão",
  shoes: "Tênis",
  dish_hand_cloths: "Panos de prato e mão",
  towels: "Toalhas",
  bedding: "Roupa de cama",
  other: "Outra lavagem",
} as const;

export type LaundryItemType = keyof typeof LAUNDRY_ITEM_LABELS;

export type LaundryRotationSettings = {
  anchor_date: string;
  anchor_member_id: string;
  gap_days: number;
  people_per_day: number;
  allow_incomplete_last_group: boolean;
  updated_at?: string;
};

export type LaundryRotationMember = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
  rotation_order: number;
};

export type LaundryRotationVersion = LaundryRotationSettings & {
  id: string;
  effective_from: string;
  created_at?: string;
  members: LaundryRotationMember[];
};

export type LaundryRotationOverride = {
  wash_date: string;
  member_id: string;
  resets_rotation: boolean;
  note: string | null;
  created_at?: string;
};

export type LaundryAssignment = {
  members: LaundryRotationMember[];
  source: "rotation" | "override";
  note: string | null;
  version: LaundryRotationVersion | null;
};

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function greatestCommonDivisor(first: number, second: number) {
  let left = Math.abs(first);
  let right = Math.abs(second);
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return left || 1;
}

function normalizedPeoplePerDay(version: LaundryRotationVersion) {
  const requested = Number.isInteger(version.people_per_day)
    ? version.people_per_day
    : 1;
  return Math.max(1, Math.min(requested, version.members.length));
}

function orderedMembers(version: LaundryRotationVersion) {
  return [...version.members].sort(
    (first, second) => first.rotation_order - second.rotation_order,
  );
}

function membersStartingAtAnchor(version: LaundryRotationVersion) {
  const members = orderedMembers(version);
  const anchorIndex = members.findIndex(
    (member) => member.id === version.anchor_member_id,
  );
  if (anchorIndex < 0) return [];
  return [...members.slice(anchorIndex), ...members.slice(0, anchorIndex)];
}

/**
 * Retorna uma volta completa do rodízio para visualização e para o cálculo das
 * datas. Com o último grupo incompleto permitido, cada morador aparece uma vez
 * por volta. Caso contrário, o fluxo é circular e todos os grupos têm
 * exatamente o tamanho configurado.
 */
export function laundryRotationGroups(version: LaundryRotationVersion) {
  const ordered = orderedMembers(version);
  if (ordered.length === 0) return [];

  const peoplePerDay = normalizedPeoplePerDay(version);
  if (version.allow_incomplete_last_group) {
    const groups: LaundryRotationMember[][] = [];
    for (let index = 0; index < ordered.length; index += peoplePerDay) {
      groups.push(ordered.slice(index, index + peoplePerDay));
    }
    const anchorGroupIndex = groups.findIndex(
      (group) => group[0]?.id === version.anchor_member_id,
    );
    if (anchorGroupIndex < 0) return [];
    return [
      ...groups.slice(anchorGroupIndex),
      ...groups.slice(0, anchorGroupIndex),
    ];
  }

  const members = membersStartingAtAnchor(version);
  if (members.length === 0) return [];
  const turnsUntilRestart =
    members.length / greatestCommonDivisor(members.length, peoplePerDay);
  return Array.from({ length: turnsUntilRestart }, (_, turn) =>
    Array.from(
      { length: peoplePerDay },
      (__, offset) => members[(turn * peoplePerDay + offset) % members.length],
    ),
  );
}

export function laundryVersionForDate(
  date: string,
  versions: LaundryRotationVersion[],
) {
  return versions
    .filter((version) => version.effective_from <= date)
    .sort((first, second) =>
      second.effective_from.localeCompare(first.effective_from),
    )[0] ?? null;
}

function memberForOverride(
  memberId: string,
  date: string,
  versions: LaundryRotationVersion[],
  knownMembers: LaundryRotationMember[],
) {
  const activeVersion = laundryVersionForDate(date, versions);
  const nearestVersion =
    activeVersion ??
    [...versions].sort((first, second) =>
      first.effective_from.localeCompare(second.effective_from),
    )[0] ??
    null;
  return (
    nearestVersion?.members.find((member) => member.id === memberId) ??
    [...versions]
      .sort((first, second) => {
        const direction = activeVersion ? -1 : 1;
        return direction * first.effective_from.localeCompare(second.effective_from);
      })
      .flatMap((version) => version.members)
      .find((member) => member.id === memberId) ??
    knownMembers.find((member) => member.id === memberId) ??
    null
  );
}

export function laundryAssignmentsForDate(
  date: string,
  versions: LaundryRotationVersion[],
  overrides: LaundryRotationOverride[],
  knownMembers: LaundryRotationMember[] = [],
): LaundryAssignment | null {
  const manual = overrides.find((item) => item.wash_date === date);
  if (manual) {
    const member = memberForOverride(
      manual.member_id,
      date,
      versions,
      knownMembers,
    );
    // Uma exceção anterior à primeira versão usa as regras de secagem da
    // primeira configuração conhecida.
    const version =
      laundryVersionForDate(date, versions) ??
      [...versions].sort((first, second) =>
        first.effective_from.localeCompare(second.effective_from),
      )[0] ??
      null;
    return member
      ? { members: [member], source: "override", note: manual.note, version }
      : null;
  }

  const version = laundryVersionForDate(date, versions);
  if (!version || version.members.length === 0) {
    return null;
  }

  // Resets antigos continuam influenciando somente a versão em que foram
  // criados. Na configuração histórica de uma pessoa por data, isso reproduz
  // exatamente a regra anterior; versões novas são alteradas pelo RPC.
  const nextVersion = versions
    .filter((candidate) => candidate.effective_from > version.effective_from)
    .sort((first, second) =>
      first.effective_from.localeCompare(second.effective_from),
    )[0];
  const latestReset = overrides
    .filter(
      (item) =>
        item.resets_rotation &&
        item.wash_date < date &&
        item.wash_date >= version.effective_from &&
        (!version.created_at ||
          !item.created_at ||
          item.created_at >= version.created_at) &&
        (!nextVersion || item.wash_date < nextVersion.effective_from),
    )
    .sort((first, second) => second.wash_date.localeCompare(first.wash_date))[0];
  const effectiveAnchorDate = latestReset?.wash_date ?? version.anchor_date;
  let effectiveAnchorMemberId =
    latestReset?.member_id ?? version.anchor_member_id;
  if (latestReset && version.allow_incomplete_last_group) {
    const members = orderedMembers(version);
    const resetMemberIndex = members.findIndex(
      (member) => member.id === latestReset.member_id,
    );
    if (resetMemberIndex >= 0) {
      const groupSize = normalizedPeoplePerDay(version);
      effectiveAnchorMemberId =
        members[Math.floor(resetMemberIndex / groupSize) * groupSize].id;
    }
  }
  const effectiveVersion = latestReset
    ? { ...version, anchor_date: effectiveAnchorDate, anchor_member_id: effectiveAnchorMemberId }
    : version;
  if (date < effectiveAnchorDate) return null;
  const elapsedDays = daysBetween(effectiveAnchorDate, date);
  const stepDays = version.gap_days + 1;
  if (elapsedDays < 0 || elapsedDays % stepDays !== 0) return null;

  const groups = laundryRotationGroups(effectiveVersion);
  if (groups.length === 0) return null;
  const turn = elapsedDays / stepDays;
  const members = groups[positiveModulo(turn, groups.length)];
  return { members, source: "rotation", note: null, version };
}

export function laundryDryingAssignmentsForDate(
  date: string,
  versions: LaundryRotationVersion[],
  overrides: LaundryRotationOverride[],
  knownMembers: LaundryRotationMember[] = [],
) {
  const maxGap = versions.reduce(
    (maximum, version) => Math.max(maximum, version.gap_days),
    0,
  );

  const dryings = [];
  for (let elapsed = 1; elapsed <= maxGap; elapsed += 1) {
    const washDate = addDays(date, -elapsed);
    const assignment = laundryAssignmentsForDate(
      washDate,
      versions,
      overrides,
      knownMembers,
    );
    const gapDays = assignment?.version?.gap_days ?? 0;
    if (assignment && elapsed <= gapDays) {
      dryings.push({
        ...assignment,
        washDate,
        dryingDay: elapsed,
        dryingUntil: addDays(washDate, gapDays),
      });
    }
  }

  return dryings;
}

export function laundryMemberNames(
  members: LaundryRotationMember[],
  fullNames = false,
) {
  return members
    .map((member) => (fullNames ? member.name : member.name.split(" ")[0]))
    .join(" e ");
}

export function laundryItemLabel(
  itemType: string,
  customLabel?: string | null,
) {
  if (itemType === "other") return customLabel?.trim() || "Outra lavagem";
  return LAUNDRY_ITEM_LABELS[itemType as LaundryItemType] ?? itemType;
}
