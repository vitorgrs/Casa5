export const HOUSE_CLEANING_AREA_DEFINITIONS = [
  { slug: "sala", name: "Sala", order: 1 },
  { slug: "quarto_1", name: "Quarto 1", order: 2 },
  { slug: "quarto_2", name: "Quarto 2", order: 3 },
  { slug: "suite", name: "Quarto da suíte", order: 4 },
  { slug: "banheiro_social", name: "Banheiro social", order: 5 },
  { slug: "banheiro_suite", name: "Banheiro da suíte", order: 6 },
  { slug: "corredor", name: "Corredor", order: 7 },
  { slug: "cozinha", name: "Cozinha", order: 8 },
  { slug: "area_servico", name: "Área de serviço", order: 9 },
  { slug: "quarto_fundos", name: "Quarto de serviço", order: 10 },
  { slug: "banheiro_servico", name: "Banheiro de serviço", order: 11 },
] as const;

export type HouseCleaningAreaDefinition =
  (typeof HOUSE_CLEANING_AREA_DEFINITIONS)[number];
export type HouseCleaningAreaSlug = HouseCleaningAreaDefinition["slug"];

export type HouseCleaningMember = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
};

export const HOUSE_CLEANING_MODES = [
  "fixed",
  "flexible",
  "balanced",
  "round_robin",
] as const;

export type HouseCleaningMode = (typeof HOUSE_CLEANING_MODES)[number];

export function isHouseCleaningMode(
  value: unknown,
): value is HouseCleaningMode {
  return (
    typeof value === "string" &&
    HOUSE_CLEANING_MODES.some((mode) => mode === value)
  );
}

type MemberWithId = { id: string };

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function greatestCommonDivisor(first: number, second: number) {
  let left = Math.abs(first);
  let right = Math.abs(second);
  while (right !== 0) [left, right] = [right, left % right];
  return left || 1;
}

function normalizedTeamSize(memberCount: number, peoplePerTurn: number) {
  if (memberCount === 0) return 0;
  const requested = Number.isInteger(peoplePerTurn) ? peoplePerTurn : 1;
  return Math.max(1, Math.min(requested, memberCount));
}

/**
 * Monta uma volta completa do rodízio. Quando o último grupo incompleto é
 * permitido, cada pessoa aparece uma vez por volta. Caso contrário, o fluxo
 * é circular e todos os grupos têm exatamente o tamanho configurado.
 */
export function houseCleaningRotationGroups<T extends MemberWithId>(
  orderedMembers: readonly T[],
  peoplePerTurn: number,
  allowIncompleteLastGroup: boolean,
): T[][] {
  if (orderedMembers.length === 0) return [];

  const teamSize = normalizedTeamSize(orderedMembers.length, peoplePerTurn);
  if (allowIncompleteLastGroup) {
    const groups: T[][] = [];
    for (let index = 0; index < orderedMembers.length; index += teamSize) {
      groups.push(orderedMembers.slice(index, index + teamSize));
    }
    return groups;
  }

  const turnsUntilRestart =
    orderedMembers.length /
    greatestCommonDivisor(orderedMembers.length, teamSize);
  return Array.from({ length: turnsUntilRestart }, (_, turn) =>
    Array.from(
      { length: teamSize },
      (__, offset) =>
        orderedMembers[(turn * teamSize + offset) % orderedMembers.length],
    ),
  );
}

export type HouseCleaningTurn<T extends MemberWithId> = {
  currentMembers: T[];
  nextMembers: T[];
};

/**
 * Resolve as equipes atual e seguinte a partir da pessoa que abre o turno.
 * Com grupos fixos, a âncora precisa ser a primeira pessoa de um dos grupos;
 * no fluxo circular, qualquer participante pode abrir a equipe atual.
 */
export function deriveHouseCleaningTurn<T extends MemberWithId>(
  orderedMembers: readonly T[],
  peoplePerTurn: number,
  allowIncompleteLastGroup: boolean,
  currentStartMemberId: string | null | undefined,
): HouseCleaningTurn<T> {
  if (!currentStartMemberId || orderedMembers.length === 0) {
    return { currentMembers: [], nextMembers: [] };
  }

  const currentIndex = orderedMembers.findIndex(
    (member) => member.id === currentStartMemberId,
  );
  if (currentIndex < 0) return { currentMembers: [], nextMembers: [] };

  if (allowIncompleteLastGroup) {
    const groups = houseCleaningRotationGroups(
      orderedMembers,
      peoplePerTurn,
      allowIncompleteLastGroup,
    );
    const currentGroupIndex = groups.findIndex(
      (group) => group[0]?.id === currentStartMemberId,
    );
    if (currentGroupIndex < 0) {
      return { currentMembers: [], nextMembers: [] };
    }
    return {
      currentMembers: groups[currentGroupIndex],
      nextMembers: groups[(currentGroupIndex + 1) % groups.length],
    };
  }

  const teamSize = normalizedTeamSize(orderedMembers.length, peoplePerTurn);
  const currentMembers = Array.from(
    { length: teamSize },
    (_, offset) =>
      orderedMembers[
        positiveModulo(currentIndex + offset, orderedMembers.length)
      ],
  );
  const nextStartIndex = positiveModulo(
    currentIndex + teamSize,
    orderedMembers.length,
  );
  const nextMembers = Array.from(
    { length: teamSize },
    (_, offset) =>
      orderedMembers[
        positiveModulo(nextStartIndex + offset, orderedMembers.length)
      ],
  );
  return { currentMembers, nextMembers };
}

export function isHouseCleaningAreaSlug(
  value: string,
): value is HouseCleaningAreaSlug {
  return HOUSE_CLEANING_AREA_DEFINITIONS.some(
    (definition) => definition.slug === value,
  );
}
