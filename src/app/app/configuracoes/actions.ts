"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, requirePermission } from "@/lib/auth";
import { currency, formatHouseDateTime } from "@/lib/format";
import { syncLatestMercadoPagoReport } from "@/lib/mercado-pago";
import { PAGE_KEYS, PERMISSION_KEYS } from "@/lib/permissions";
import { RECEIPT_BUCKET } from "@/lib/storage";
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
  const { profile, supabase } = await requirePermission("manage_wallet");
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

export async function syncMercadoPago(formData?: FormData) {
  const { profile, supabase } = await requirePermission("manage_wallet");
  // A sincronização é disparada de Configurações e de Conta da casa.
  const returnTo = formData
    ? pathOf(destination(formData, "/app/configuracoes"))
    : "/app/configuracoes";
  let target: string;
  try {
    const result = await syncLatestMercadoPagoReport(
      supabase,
      profile.household_id!,
      profile.id,
    );
    revalidatePath("/app/configuracoes");
    revalidatePath("/app/financeiro");

    let message: string;
    const formattedBalance =
      result.balance === null ? null : currency.format(result.balance);
    const reference = result.latestReportDate
      ? formatHouseDateTime(result.latestReportDate)
      : null;
    const balanceSummary = formattedBalance
      ? `Saldo confirmado: ${formattedBalance}${reference ? `, com referência em ${reference}` : ""}.`
      : "";
    if (result.requestDetail) {
      message = `${balanceSummary} O Mercado Pago recusou a nova atualização. ${result.requestDetail}`.trim();
    } else if (result.imported) {
      message = `${balanceSummary || "Novo relatório importado com sucesso."}${
        result.requested
          ? " Como a referência anterior tinha 24 horas ou mais, uma nova atualização também foi solicitada."
          : ""
      }`;
    } else if (result.requested) {
      message = `${balanceSummary} A referência tinha 24 horas ou mais, então uma nova atualização foi solicitada. O Mercado Pago a processa de forma assíncrona.`.trim();
    } else if (result.pending) {
      message = `${balanceSummary} Já existe uma atualização recente em processamento no Mercado Pago.`.trim();
    } else if (result.latestReportReady) {
      message = balanceSummary || "Nenhum relatório novo encontrado desde a última sincronização.";
    } else {
      message =
        "Ainda não há arquivo pronto para importar. O Mercado Pago já recebeu a solicitação; aguarde a disponibilização do relatório.";
    }
    if (result.payerLookup?.found) {
      message = `${message} ${result.payerLookup.found} pagador(es) identificado(s) no extrato.`;
    }
    const kind = result.requestDetail ? "error" : "success";
    target = `${returnTo}?${kind}=${encodeURIComponent(message)}`;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Falha ao sincronizar.";
    target = `${returnTo}?error=${encodeURIComponent(message)}`;
  }
  redirect(target);
}

export async function updatePermissions(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes/permissoes");
  // Editar permissões nunca é delegável; o banco confere isso de novo.
  const { supabase } = await requireAdmin();
  const profileId = String(formData.get("profile_id") ?? "");
  const grantedPermissions = PERMISSION_KEYS.filter(
    (key) => formData.get(`perm_${key}`) === "on",
  );
  // A tela mostra as páginas visíveis marcadas; guardamos as desmarcadas.
  const hiddenPages = PAGE_KEYS.filter(
    (key) => formData.get(`page_${key}`) !== "on",
  );
  const { error } = await supabase.rpc("set_profile_access", {
    target_profile_id: profileId,
    granted_permissions: grantedPermissions,
    hidden_page_keys: hiddenPages,
  });
  const base = pathOf(returnTo);
  if (error) {
    redirect(`${base}?error=${encodeURIComponent(error.message)}#perfil-${profileId}`);
  }
  revalidatePath("/app", "layout");
  redirect(
    `${base}?success=${encodeURIComponent("Acesso atualizado.")}#perfil-${profileId}`,
  );
}

export async function updateReminderSettings(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes");
  const { profile, supabase } = await requirePermission("manage_notifications");
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
  const { profile } = await requirePermission("manage_notifications");
  // O log anti-spam só aceita escrita pela service role. A rotina manual
  // autentica o administrador acima e usa o mesmo cliente do cron no envio.
  const supabase = createServiceClient();
  const { runExpenseReminders } = await import("@/lib/reminders");
  const result = await runExpenseReminders(supabase, profile.household_id!);
  revalidatePath(pathOf(returnTo));
  const kind = result.ok ? "success" : "error";
  redirect(`${pathOf(returnTo)}?${kind}=${encodeURIComponent(`Lembretes: ${result.message}`)}`);
}

export async function sendDailyEmailsNow(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes");
  const { profile } = await requirePermission("manage_notifications");
  const supabase = createServiceClient();
  const [{ runDailyChoreReminder }, { runDailyLaundryReminder }] =
    await Promise.all([
      import("@/lib/chore-reminders"),
      import("@/lib/laundry-reminders"),
    ]);
  const [chore, laundry] = await Promise.all([
    runDailyChoreReminder(supabase, profile.household_id!),
    runDailyLaundryReminder(supabase, profile.household_id!),
  ]);
  revalidatePath(pathOf(returnTo));
  const kind = chore.ok && laundry.ok ? "success" : "error";
  const message = `Rotina da casa: ${chore.message} Lavanderia: ${laundry.message}`;
  redirect(
    `${pathOf(returnTo)}?${kind}=${encodeURIComponent(message)}`,
  );
}

export async function sendOpenSettlementsNow(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes");
  const { profile } = await requirePermission("manage_notifications");
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

export async function cleanOrphanReceipts(formData: FormData) {
  const returnTo = destination(formData, "/app/configuracoes");
  const { supabase } = await requirePermission("manage_storage");
  // A função valida o administrador e só devolve arquivos da casa dele, sem
  // referência no banco e com mais de 24 horas (uploads em andamento ficam).
  const { data: orphans, error } = await supabase.rpc(
    "list_orphan_receipt_objects",
    { max_items: 500 },
  );
  if (error) {
    redirect(
      `${pathOf(returnTo)}?error=${encodeURIComponent(`Armazenamento: ${error.message}`)}`,
    );
  }

  const paths = ((orphans ?? []) as { path: string }[]).map((orphan) => orphan.path);
  const service = createServiceClient();
  let removed = 0;
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100);
    const { data, error: removeError } = await service.storage
      .from(RECEIPT_BUCKET)
      .remove(batch);
    if (removeError) {
      redirect(
        `${pathOf(returnTo)}?error=${encodeURIComponent(`Armazenamento: ${removed} arquivo(s) removido(s) antes do erro: ${removeError.message}`)}`,
      );
    }
    removed += data?.length ?? 0;
  }

  revalidatePath(pathOf(returnTo));
  const message = removed
    ? `Armazenamento: ${removed} arquivo(s) sem uso removido(s).`
    : "Armazenamento: nenhum arquivo sem uso encontrado.";
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent(message)}`);
}
