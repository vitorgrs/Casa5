import {
  firstAbsenceAffecting,
  isMemberAway,
  type MemberAbsence,
} from "./member-absences.ts";

export const HOUSE_TIME_ZONE = "America/Sao_Paulo";

export type StandardDailyTask = {
  id: string;
  task_key: string;
  label: string;
  description: string | null;
  display_order: number;
  active: boolean;
};

export type RotationMember = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
  rotation_order: number;
};

export type RotationSwap = {
  requester_member_id: string;
  requester_date: string;
  target_member_id: string;
  target_date: string;
  status: "pending" | "approved" | "rejected";
};

function dateFromIso(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function isIsoDate(value?: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return dateFromIso(value).toISOString().slice(0, 10) === value;
}

export function todayIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOUSE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(iso: string, amount: number) {
  const date = dateFromIso(iso);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(startIso: string, endIso: string) {
  return Math.floor((dateFromIso(endIso).getTime() - dateFromIso(startIso).getTime()) / 86_400_000);
}

export function formatHouseDate(iso: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...options,
  }).format(dateFromIso(iso));
}

/**
 * Responsável pela escala diária em uma data. A vez anda um morador por dia
 * na ordem da escala e pula quem está fora de casa naquele dia; ao voltar, a
 * pessoa retoma a mesma posição. Sem ausências o resultado é o mesmo do
 * cálculo direto (dias desde o início módulo a quantidade de moradores).
 * Espelha public.daily_rotation_assignee (migration 038).
 */
export function rotationMemberForDate(
  date: string,
  startDate: string | null,
  members: RotationMember[],
  swaps: RotationSwap[],
  absences: readonly MemberAbsence[] = [],
) {
  if (!startDate || date < startDate || members.length === 0) return null;

  const approvedSwap = swaps.find(
    (swap) =>
      swap.status === "approved" &&
      (swap.requester_date === date || swap.target_date === date),
  );
  if (approvedSwap) {
    const assignedMemberId =
      approvedSwap.requester_date === date
        ? approvedSwap.target_member_id
        : approvedSwap.requester_member_id;
    return members.find((member) => member.id === assignedMemberId) ?? null;
  }

  const firstAbsence = firstAbsenceAffecting(
    new Set(members.map((member) => member.id)),
    startDate,
    date,
    absences,
  );
  if (!firstAbsence) {
    const offset = daysBetween(startDate, date) % members.length;
    return members[offset] ?? null;
  }

  // Até a primeira ausência vale o cálculo direto; dali em diante a vez anda
  // dia a dia.
  let previousIndex =
    firstAbsence > startDate
      ? (daysBetween(startDate, firstAbsence) - 1) % members.length
      : members.length - 1;
  for (let day = firstAbsence; day <= date; day = addDays(day, 1)) {
    let foundIndex: number | null = null;
    for (let step = 1; step <= members.length; step += 1) {
      const candidate = (previousIndex + step) % members.length;
      if (!isMemberAway(members[candidate].id, day, absences)) {
        foundIndex = candidate;
        break;
      }
    }
    if (day === date) return foundIndex === null ? null : members[foundIndex];
    if (foundIndex !== null) previousIndex = foundIndex;
  }
  return null;
}

export function dateIsInActiveSwap(date: string, swaps: RotationSwap[]) {
  return swaps.some(
    (swap) =>
      swap.status !== "rejected" &&
      (swap.requester_date === date || swap.target_date === date),
  );
}
