"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { syncLatestMercadoPagoReport } from "@/lib/mercado-pago";
import { PERMISSION_CATALOG } from "@/lib/permissions";

function destination(formData: FormData, fallback: string) {
  const value = String(formData.get("redirect_to") ?? "");
  return value.startsWith("/app") ? value : fallback;
}

function pathOf(url: string) {
  return url.split("?")[0] || "/app";
}

function valueToMoney(value: FormDataEntryValue | null) {
  let text = String(value ?? "")
    .trim()
    .replace(/\s/g, "");
  if (text.includes(",") && text.includes("."))
    text = text.replace(/\./g, "").replace(",", ".");
  else if (text.includes(",")) text = text.replace(",", ".");
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error("Saldo inválido.");
  return Math.round(parsed * 100) / 100;
}

export async function addManualBalance(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes");
  const { profile, supabase } = await requireAdmin();
  const { error } = await supabase.from("wallet_snapshots").insert({
    household_id: profile.household_id,
    balance: valueToMoney(formData.get("balance")),
    source: "manual",
    observed_at: new Date().toISOString(),
    created_by: profile.id,
  });
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function syncMercadoPago() {
  const { profile, supabase } = await requireAdmin();
  let destination: string;
  try {
    const result = await syncLatestMercadoPagoReport(
      supabase,
      profile.household_id!,
      profile.id,
    );
    revalidatePath("/app/configuracoes");

    let message: string;
    if (result.imported) {
      message = "Novo relatório importado com sucesso.";
    } else if (result.reportsFound === 0 && result.requestDetail) {
      message = `O Mercado Pago recusou a criação do relatório. ${result.requestDetail}`;
    } else if (result.reportsFound === 0) {
      message =
        "Nenhum relatório encontrado ainda. Uma nova geração foi solicitada; isso pode levar algumas horas na primeira vez.";
    } else if (result.latestReportStatus && result.latestReportStatus !== "processed") {
      message = `Já existe um relatório sendo processado pelo Mercado Pago (status: ${result.latestReportStatus}). Aguarde e sincronize novamente em algumas horas.`;
    } else {
      message = "Nenhum relatório novo encontrado desde a última sincronização.";
    }
    const kind = result.imported || result.reportsFound > 0 ? "success" : "error";
    destination = `/app/configuracoes?${kind}=${encodeURIComponent(message)}`;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Falha ao sincronizar.";
    destination = `/app/configuracoes?error=${encodeURIComponent(message)}`;
  }
  redirect(destination);
}

export async function updatePermissions(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes/permissoes");
  const { supabase } = await requireAdmin();
  const profileId = String(formData.get("profile_id"));
  const permissions: Record<string, boolean> = {};
  for (const item of PERMISSION_CATALOG) {
    permissions[item.key] = formData.get(`perm_${item.key}`) === "on";
  }
  const { error } = await supabase
    .from("profiles")
    .update({ permissions })
    .eq("id", profileId);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent("Permissões atualizadas.")}`);
}

export async function updateReminderSettings(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes");
  const { profile, supabase } = await requireAdmin();
  const remindersEnabled = formData.get("reminders_enabled") === "on";
  const daysBefore = Math.min(Math.max(Number(formData.get("reminder_days_before") ?? 3), 0), 14);
  const { error } = await supabase.from("household_settings").upsert({
    household_id: profile.household_id,
    reminders_enabled: remindersEnabled,
    reminder_days_before: daysBefore,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent("Preferências de lembrete salvas.")}`);
}
