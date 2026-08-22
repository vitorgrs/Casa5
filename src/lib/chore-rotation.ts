export const HOUSE_TIME_ZONE = "America/Sao_Paulo";

export const STANDARD_DAILY_TASKS = [
  { key: "kitchen_trash", label: "Verificar o lixo da cozinha" },
  { key: "bathroom_1_trash", label: "Verificar o lixo do banheiro 1" },
  { key: "bathroom_2_trash", label: "Verificar o lixo do banheiro 2" },
  { key: "bathroom_3_trash", label: "Verificar o lixo do banheiro 3" },
  { key: "water_bottles", label: "Encher as garrafas de água" },
] as const;

export type StandardDailyTaskKey = (typeof STANDARD_DAILY_TASKS)[number]["key"];

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

export function rotationMemberForDate(
  date: string,
  startDate: string | null,
  members: RotationMember[],
  swaps: RotationSwap[],
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

  const offset = daysBetween(startDate, date) % members.length;
  return members[offset] ?? null;
}

export function dateIsInActiveSwap(date: string, swaps: RotationSwap[]) {
  return swaps.some(
    (swap) =>
      swap.status !== "rejected" &&
      (swap.requester_date === date || swap.target_date === date),
  );
}
