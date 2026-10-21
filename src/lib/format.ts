import { HOUSE_TIME_ZONE, todayIso } from "@/lib/chore-rotation";

export const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL"
});

// Os três formatadores abaixo recebem datas de calendário (sem hora). Fixar
// UTC mantém o mesmo dia no servidor da Vercel (UTC) e no navegador (UTC-3).
export const shortDate = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC"
});

export const fullDate = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});

export const monthLabel = new Intl.DateTimeFormat("pt-BR", {
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});

// Datas com hora (timestamptz) precisam do fuso da casa: no servidor da
// Vercel o fuso padrão é UTC e um evento às 22h apareceria no dia seguinte.
// Datas puras (AAAA-MM-DD) são lidas ao meio-dia para não mudar de dia.
function toHouseDate(value: string | Date) {
  if (value instanceof Date) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00-03:00`)
    : new Date(value);
}

export function formatHouseTimestamp(value: string | Date | null | undefined) {
  if (!value) return "data não informada";
  const date = toHouseDate(value);
  if (Number.isNaN(date.getTime())) return "data não informada";
  return date.toLocaleDateString("pt-BR", { timeZone: HOUSE_TIME_ZONE });
}

export function formatHouseDateTime(value: string | Date | null | undefined) {
  if (!value) return "data não informada";
  const date = toHouseDate(value);
  if (Number.isNaN(date.getTime())) return "data não informada";
  return date.toLocaleString("pt-BR", { timeZone: HOUSE_TIME_ZONE });
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.replace(",", ".")) || 0;
  return 0;
}

export function isoMonth(): string {
  return `${todayIso().slice(0, 7)}-01`;
}

// Compara dias de calendário no fuso da casa; usar a hora local do servidor
// (UTC) adiantava o "hoje" depois das 21h e marcava vencimentos um dia antes.
export function daysUntil(date?: string | null): number | null {
  if (!date) return null;
  const target = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayIso()}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  return Math.round((target - today) / 86_400_000);
}

export function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}
