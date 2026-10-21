"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

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
