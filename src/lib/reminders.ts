import type { SupabaseClient } from "@supabase/supabase-js";
import { emailConfigured, expenseReminderEmail, sendEmail } from "@/lib/email";

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
      message:
        "RESEND_API_KEY e/ou RESEND_FROM não estão definidos nas variáveis de ambiente.",
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

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const daysBefore = settings?.reminder_days_before ?? 3;
  const windowEnd = new Date(today);
  windowEnd.setDate(windowEnd.getDate() + daysBefore);
  const windowEndIso = windowEnd.toISOString().slice(0, 10);

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
  let sent = 0;
  let candidates = 0;
  let skippedAlreadySent = 0;
  const failures: { to: string; error: string }[] = [];

  for (const expense of dueExpenses ?? []) {
    const shares = expense.expense_shares ?? [];
    for (const share of shares) {
      if (!["pending", "late"].includes(share.payment_status)) continue;
      const member = Array.isArray(share.member) ? share.member[0] : share.member;
      if (!member?.email) continue;
      candidates += 1;

      const { error: logError } = await supabase.from("expense_reminder_log").insert({
        expense_share_id: share.id,
        reminder_date: todayIso,
      });
      // unique(expense_share_id, reminder_date) impede reenviar no mesmo dia.
      if (logError) {
        skippedAlreadySent += 1;
        continue;
      }

      const dueDate = expense.due_date as string;
      const daysLeft = Math.round(
        (new Date(`${dueDate}T00:00:00`).getTime() - today.getTime()) / 86_400_000,
      );
      const { subject, html } = expenseReminderEmail({
        memberName: member.name,
        expenseTitle: expense.title,
        amount: Number(share.amount),
        dueDate,
        daysLeft,
        appUrl,
      });
      try {
        await sendEmail({ to: member.email, subject, html });
        sent += 1;
      } catch (error) {
        failures.push({
          to: member.email,
          error: error instanceof Error ? error.message : "Erro desconhecido",
        });
        // Libera o registro de log para permitir nova tentativa depois,
        // já que o e-mail não foi realmente entregue.
        await supabase
          .from("expense_reminder_log")
          .delete()
          .eq("expense_share_id", share.id)
          .eq("reminder_date", todayIso);
      }
    }
  }

  let message = `${sent} de ${candidates} lembrete(s) enviado(s).`;
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
