import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, daysBetween, todayIso as houseTodayIso } from "@/lib/chore-rotation";
import {
  emailConfigurationError,
  emailConfigured,
  emailProviderName,
  expenseReminderEmail,
  sendEmail,
} from "@/lib/email";

export type ReminderRunResult = {
  ok: boolean;
  sent: number;
  candidates: number;
  skippedAlreadySent: number;
  failures: { to: string; error: string }[];
  message: string;
};

/**
 * Roda a checagem e o envio de lembretes de vencimento por e-mail.
 * Usado tanto pelo cron diário quanto por um botão manual em Configurações,
 * para que o administrador consiga testar sem esperar o cron da Vercel.
 */
export async function runExpenseReminders(
  supabase: SupabaseClient,
  householdId: string,
): Promise<ReminderRunResult> {
  if (!emailConfigured()) {
    return {
      ok: false,
      sent: 0,
      candidates: 0,
      skippedAlreadySent: 0,
      failures: [],
      message: emailConfigurationError(),
    };
  }

  const { data: settings } = await supabase
    .from("household_settings")
    .select("reminders_enabled,reminder_days_before")
    .eq("household_id", householdId)
    .maybeSingle();

  if (settings?.reminders_enabled === false) {
    return {
      ok: true,
      sent: 0,
      candidates: 0,
      skippedAlreadySent: 0,
      failures: [],
      message: "Lembretes estão desativados nas configurações da casa.",
    };
  }

  const todayIso = houseTodayIso();
  const daysBefore = settings?.reminder_days_before ?? 3;
  const windowEndIso = addDays(todayIso, daysBefore);

  const { data: dueExpenses, error: queryError } = await supabase
    .from("expenses")
    .select(
      "id,title,due_date,expense_shares(id,amount,payment_status,member:household_members(name,email))",
    )
    .eq("household_id", householdId)
    .not("due_date", "is", null)
    .lte("due_date", windowEndIso)
    .in("status", ["planned", "open"]);

  if (queryError) {
    return {
      ok: false,
      sent: 0,
      candidates: 0,
      skippedAlreadySent: 0,
      failures: [],
      message: `Erro ao buscar despesas em aberto: ${queryError.message}`,
    };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://casa5.vercel.app";
  type ReminderJob = {
    shareId: string;
    memberName: string;
    email: string;
    expenseTitle: string;
    amount: number;
    dueDate: string;
  };
  const jobs: ReminderJob[] = [];

  for (const expense of dueExpenses ?? []) {
    for (const share of expense.expense_shares ?? []) {
      if (!["pending", "late"].includes(share.payment_status)) continue;
      const member = Array.isArray(share.member) ? share.member[0] : share.member;
      if (!member?.email || !expense.due_date) continue;
      jobs.push({
        shareId: share.id,
        memberName: member.name,
        email: member.email,
        expenseTitle: expense.title,
        amount: Number(share.amount),
        dueDate: expense.due_date,
      });
    }
  }

  let sent = 0;
  const candidates = jobs.length;
  let skippedAlreadySent = 0;
  const failures: { to: string; error: string }[] = [];

  async function processJob(job: ReminderJob) {
    const { error: logError } = await supabase
      .from("expense_reminder_log")
      .insert({
        expense_share_id: job.shareId,
        reminder_date: todayIso,
      });
    // unique(expense_share_id, reminder_date) impede reenviar no mesmo dia.
    if (logError) {
      if (logError.code === "23505") {
        skippedAlreadySent += 1;
      } else {
        failures.push({
          to: job.email,
          error: `Não foi possível registrar o envio: ${logError.message}`,
        });
      }
      return;
    }

    const daysLeft = daysBetween(todayIso, job.dueDate);
    const { subject, html } = expenseReminderEmail({
      memberName: job.memberName,
      expenseTitle: job.expenseTitle,
      amount: job.amount,
      dueDate: job.dueDate,
      daysLeft,
      appUrl,
    });
    try {
      await sendEmail({
        to: job.email,
        subject,
        html,
        tags: ["casa5-lembrete-vencimento"],
        idempotencyKey: `expense-reminder:${todayIso}:${job.shareId}`,
      });
      sent += 1;
    } catch (error) {
      failures.push({
        to: job.email,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
      // Libera o registro de log para permitir nova tentativa depois,
      // já que o e-mail não foi realmente entregue.
      await supabase
        .from("expense_reminder_log")
        .delete()
        .eq("expense_share_id", job.shareId)
        .eq("reminder_date", todayIso);
    }
  }

  // Cinco moradores podem ser avisados em paralelo sem serializar um timeout
  // de rede por destinatário. O limite evita uma rajada desnecessária na API.
  let nextJob = 0;
  async function worker() {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob];
      nextJob += 1;
      await processJob(job);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(5, jobs.length) }, () => worker()),
  );

  const provider = emailProviderName() ?? "O provedor de e-mail";
  let message = `${provider} aceitou ${sent} de ${candidates} lembrete(s) para processamento. Isso ainda não confirma a entrega; acompanhe os logs no painel do provedor.`;
  if (skippedAlreadySent > 0) {
    message += ` ${skippedAlreadySent} já tinham sido avisados hoje.`;
  }
  if (failures.length > 0) {
    message += ` ${failures.length} falharam — ${failures[0].error}`;
  }
  if (candidates === 0) {
    message = "Nenhuma despesa em aberto dentro da janela de lembrete no momento.";
  }

  return { ok: failures.length === 0, sent, candidates, skippedAlreadySent, failures, message };
}
