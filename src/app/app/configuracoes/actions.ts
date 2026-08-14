"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { currency } from "@/lib/format";
import { syncLatestMercadoPagoReport } from "@/lib/mercado-pago";
import { PERMISSION_CATALOG } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase/service";

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
    const formattedBalance =
      result.balance === null ? null : currency.format(result.balance);
    if (result.imported) {
      message = formattedBalance
        ? `Relatório processado com sucesso. Saldo identificado: ${formattedBalance}.`
        : "Novo relatório importado com sucesso.";
    } else if (result.requestDetail) {
      message = `O Mercado Pago recusou a criação do relatório. ${result.requestDetail}`;
    } else if (result.requested) {
      message =
        "Uma nova geração foi solicitada ao Mercado Pago. O processamento é assíncrono; sincronize novamente mais tarde para importar o arquivo.";
    } else if (result.latestTaskStatus === "pending") {
      message =
        "O relatório mais recente ainda está sendo processado pelo Mercado Pago. Aguarde e sincronize novamente mais tarde.";
    } else if (result.latestReportReady) {
      message = formattedBalance
        ? `O relatório mais recente já estava importado. Saldo confirmado: ${formattedBalance}.`
        : "Nenhum relatório novo encontrado desde a última sincronização.";
    } else {
      message =
        "Ainda não há arquivo pronto para importar. O Mercado Pago já recebeu a solicitação; aguarde a disponibilização do relatório.";
    }
    const kind = result.requestDetail ? "error" : "success";
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

export async function sendRemindersNow(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes");
  const { profile } = await requireAdmin();
  // O log anti-spam só aceita escrita pela service role. A rotina manual
  // autentica o administrador acima e usa o mesmo cliente do cron no envio.
  const supabase = createServiceClient();
  const { runExpenseReminders } = await import("@/lib/reminders");
  const result = await runExpenseReminders(supabase, profile.household_id!);
  revalidatePath(pathOf(returnTo));
  const kind = result.ok ? "success" : "error";
  redirect(`${pathOf(returnTo)}?${kind}=${encodeURIComponent(`Lembretes: ${result.message}`)}`);
}

export async function sendOpenSettlementsNow(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes");
  const { profile } = await requireAdmin();
  const supabase = createServiceClient();
  const { runOpenSettlementEmails } = await import("@/lib/settlement-emails");
  const result = await runOpenSettlementEmails(
    supabase,
    profile.household_id!,
  );
  revalidatePath(pathOf(returnTo));
  const kind = result.ok ? "success" : "error";
  redirect(
    `${pathOf(returnTo)}?${kind}=${encodeURIComponent(`Acertos: ${result.message}`)}`,
  );
}
