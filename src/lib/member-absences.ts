import type { SupabaseClient } from "@supabase/supabase-js";

// Período em que um morador está fora de casa. `left_on` é o primeiro dia
// fora e `returned_on` o primeiro dia de volta (intervalo semiaberto), igual
// à tabela public.member_absences (migration 038).
export type MemberAbsence = {
  id?: string;
  member_id: string;
  left_on: string;
  returned_on: string | null;
  note?: string | null;
};

export function isMemberAway(
  memberId: string,
  date: string,
  absences: readonly MemberAbsence[],
) {
  return absences.some(
    (absence) =>
      absence.member_id === memberId &&
      absence.left_on <= date &&
      (absence.returned_on === null || absence.returned_on > date) &&
      absence.returned_on !== absence.left_on,
  );
}

export function awayMemberIds(date: string, absences: readonly MemberAbsence[]) {
  return new Set(
    absences
      .filter((absence) => isMemberAway(absence.member_id, date, [absence]))
      .map((absence) => absence.member_id),
  );
}

/** Ausência em vigor hoje ou agendada para depois de hoje. */
export function currentOrUpcomingAbsence(
  memberId: string,
  today: string,
  absences: readonly MemberAbsence[],
) {
  return (
    absences
      .filter(
        (absence) =>
          absence.member_id === memberId &&
          absence.returned_on !== absence.left_on &&
          (absence.returned_on === null || absence.returned_on > today),
      )
      .sort((first, second) => first.left_on.localeCompare(second.left_on))[0] ??
    null
  );
}

/**
 * Primeira data em que alguma ausência relevante começa a valer, limitada ao
 * período [desde, até]. Retorna null quando nenhuma ausência afeta o período,
 * o que permite aos rodízios usar o cálculo direto (módulo).
 */
export function firstAbsenceAffecting(
  memberIds: ReadonlySet<string>,
  from: string,
  until: string,
  absences: readonly MemberAbsence[],
) {
  let first: string | null = null;
  for (const absence of absences) {
    if (!memberIds.has(absence.member_id)) continue;
    if (absence.returned_on === absence.left_on) continue;
    if (absence.left_on > until) continue;
    if (absence.returned_on !== null && absence.returned_on <= from) continue;
    const start = absence.left_on > from ? absence.left_on : from;
    if (first === null || start < first) first = start;
  }
  return first;
}

// Antes da migration 038 a tabela não existe; nesse caso os rodízios
// continuam funcionando como antes, sem ausências.
export async function loadMemberAbsences(
  supabase: SupabaseClient,
  householdId: string | null,
): Promise<MemberAbsence[]> {
  if (!householdId) return [];
  const { data, error } = await supabase
    .from("member_absences")
    .select("id,member_id,left_on,returned_on,note")
    .eq("household_id", householdId)
    .order("left_on", { ascending: false })
    .limit(200);
  if (error) return [];
  return (data ?? []) as MemberAbsence[];
}
