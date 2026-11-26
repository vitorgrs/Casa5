"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import type { FormActionState } from "@/lib/form-action-state";

function destination(formData: FormData, fallback: string) {
  const value = String(formData.get("redirect_to") ?? "");
  return value.startsWith("/app") ? value : fallback;
}

function pathOf(url: string) {
  return url.split("?")[0] || "/app";
}

// Aceita e-mails e CPFs. CPFs são guardados só com dígitos para comparar com
// o que a API de pagamentos devolve.
function parsePayerIdentifiers(raw: string): { values: string[] } | { error: string } {
  const values: string[] = [];
  for (const item of raw.split(/[,;\n]/).map((value) => value.trim()).filter(Boolean)) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) {
      values.push(item.toLowerCase());
      continue;
    }
    const digitsOnly = item.replace(/\D/g, "");
    if (digitsOnly.length === 11) {
      values.push(digitsOnly);
      continue;
    }
    return { error: `“${item}” não é um e-mail nem um CPF com 11 dígitos.` };
  }
  if (values.length > 5) return { error: "Informe no máximo 5 identificações por morador." };
  return { values: Array.from(new Set(values)) };
}

export async function updateMemberEmail(formData: FormData) {
  const returnTo = destination(formData, "/app/moradores");
  const { profile, supabase } = await requirePermission("manage_members");
  const email =
    String(formData.get("email") ?? "")
      .trim()
      .toLowerCase() || null;
  const pixKey = String(formData.get("pix_key") ?? "").trim() || null;
  const update: Record<string, unknown> = { email, pix_key: pixKey };
  if (formData.has("payer_identifiers")) {
    const parsed = parsePayerIdentifiers(String(formData.get("payer_identifiers") ?? ""));
    if ("error" in parsed) {
      redirect(`${pathOf(returnTo)}?error=${encodeURIComponent(parsed.error)}`);
    }
    update.payer_identifiers = parsed.values;
  }
  const { error } = await supabase
    .from("household_members")
    .update(update)
    .eq("id", String(formData.get("member_id")))
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function linkPendingProfile(formData: FormData) {
  const returnTo = destination(formData, "/app/moradores");
  const { profile, supabase } = await requirePermission("manage_members");
  const email = String(formData.get("profile_email") ?? "")
    .trim()
    .toLowerCase();
  const memberId = String(formData.get("member_id") ?? "");
  const { error } = await supabase
    .from("household_members")
    .update({ email })
    .eq("id", memberId)
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

// ----------------------------------------------------------------------
// Fora de casa: a pessoa sai de todos os rodízios até voltar
// ----------------------------------------------------------------------

function isoDate(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function absenceRevalidate() {
  for (const path of [
    "/app",
    "/app/moradores",
    "/app/limpeza",
    "/app/limpeza/lavanderia",
    "/app/limpeza/agua",
    "/app/limpeza/fogao",
    "/app/limpeza/louca",
    "/app/limpeza/mapa",
  ]) {
    revalidatePath(path);
  }
}

export async function markMemberAway(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  try {
    const { supabase } = await requirePermission("manage_members");
    const memberId = String(formData.get("member_id") ?? "");
    const awayFrom = isoDate(formData.get("away_from"));
    const note = String(formData.get("note") ?? "").trim();
    if (!memberId) return { status: "error", message: "Morador inválido." };
    if (!awayFrom) return { status: "error", message: "Informe a data de saída." };
    if (note.length > 300) {
      return { status: "error", message: "A observação deve ter no máximo 300 caracteres." };
    }

    const { error } = await supabase.rpc("mark_member_away", {
      target_member_id: memberId,
      away_from: awayFrom,
      away_note: note || null,
    });
    if (error) return { status: "error", message: error.message };

    absenceRevalidate();
    return {
      status: "success",
      message: "Saída registrada. A pessoa foi retirada dos rodízios a partir dessa data.",
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível registrar a saída.",
    };
  }
}

export async function markMemberReturned(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  try {
    const { supabase } = await requirePermission("manage_members");
    const memberId = String(formData.get("member_id") ?? "");
    const returnedOn = isoDate(formData.get("returned_on"));
    if (!memberId) return { status: "error", message: "Morador inválido." };
    if (!returnedOn) return { status: "error", message: "Informe a data de volta." };

    const { error } = await supabase.rpc("mark_member_returned", {
      target_member_id: memberId,
      returned_on_date: returnedOn,
    });
    if (error) return { status: "error", message: error.message };

    absenceRevalidate();
    return {
      status: "success",
      message:
        formData.get("cancel") === "1"
          ? "Saída agendada cancelada."
          : "Volta registrada. A pessoa retoma a mesma posição nos rodízios.",
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível registrar a volta.",
    };
  }
}
