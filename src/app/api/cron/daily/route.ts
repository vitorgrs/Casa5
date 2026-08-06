import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { syncLatestMercadoPagoReport } from "@/lib/mercado-pago";
import { emailConfigured, expenseReminderEmail, sendEmail } from "@/lib/email";

export const maxDuration = 60;

function firstDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function dueDateForMonth(dueDate: string | null, targetMonth: string) {
  if (!dueDate) return null;
  const day = Number(dueDate.slice(8, 10));
  const [year, month] = targetMonth.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${targetMonth}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const householdId = "11111111-1111-1111-1111-111111111111";
  const result = {
    lateShares: 0,
    recurringCreated: 0,
    mercadoPago: "não executado",
    remindersSent: 0,
    reminders: "não executado",
  };

  const { data: overdueExpenses } = await supabase
    .from("expenses")
    .select("id")
    .eq("household_id", householdId)
    .lt("due_date", todayIso)
    .in("status", ["planned", "open"]);

  const overdueIds = (overdueExpenses ?? []).map((expense) => expense.id);
  if (overdueIds.length) {
    const { data: late } = await supabase
      .from("expense_shares")
      .update({ payment_status: "late" })
      .in("expense_id", overdueIds)
      .eq("payment_status", "pending")
      .select("id");
    result.lateShares = late?.length ?? 0;
  }

  const target = new Date(today.getFullYear(), today.getMonth() + (today.getDate() >= 20 ? 1 : 0), 1);
  const targetMonth = firstDay(target);
  const { data: recurring } = await supabase
    .from("expenses")
    .select("id,title,category,description,reference_month,due_date,amount,estimated,split_mode,recurrence,series_id,expense_shares(member_id,amount)")
    .eq("household_id", householdId)
    .eq("recurrence", "monthly")
    .not("series_id", "is", null)
    .order("reference_month", { ascending: false });

  type RecurringExpense = NonNullable<typeof recurring>[number];
  const latestBySeries = new Map<string, RecurringExpense>();
  for (const expense of recurring ?? []) {
    if (!latestBySeries.has(expense.series_id!)) latestBySeries.set(expense.series_id!, expense);
  }

  for (const expense of latestBySeries.values()) {
    if (!expense || expense.reference_month >= targetMonth) continue;
    const { data: existing } = await supabase
      .from("expenses")
      .select("id")
      .eq("household_id", householdId)
      .eq("series_id", expense.series_id)
      .eq("reference_month", targetMonth)
      .maybeSingle();
    if (existing) continue;

    const { data: created, error } = await supabase
      .from("expenses")
      .insert({
        household_id: householdId,
        title: expense.title,
        category: expense.category,
        description: expense.description,
        reference_month: targetMonth,
        due_date: dueDateForMonth(expense.due_date, targetMonth.slice(0, 7)),
        amount: expense.amount,
        estimated: expense.estimated,
        split_mode: expense.split_mode,
        status: expense.amount === null ? "planned" : "open",
        recurrence: "monthly",
        series_id: expense.series_id,
        source_expense_id: expense.id
      })
      .select("id")
      .single();

    if (!error && created) {
      const shares = expense.expense_shares ?? [];
      if (shares.length) {
        await supabase.from("expense_shares").insert(shares.map((share) => ({
          expense_id: created.id,
          member_id: share.member_id,
          amount: share.amount,
          payment_status: "pending"
        })));
      }
      result.recurringCreated += 1;
    }
  }

  if (process.env.MERCADO_PAGO_ACCESS_TOKEN) {
    try {
      const mp = await syncLatestMercadoPagoReport(supabase, householdId, null);
      result.mercadoPago = mp.imported ? "relatório importado" : "nova geração solicitada";
    } catch (error) {
      result.mercadoPago = error instanceof Error ? `erro: ${error.message}` : "erro desconhecido";
    }
  }

  if (!emailConfigured()) {
    result.reminders = "RESEND_API_KEY/RESEND_FROM não configurados";
  } else {
    const { data: settings } = await supabase
      .from("household_settings")
      .select("reminders_enabled,reminder_days_before")
      .eq("household_id", householdId)
      .maybeSingle();

    if (settings?.reminders_enabled === false) {
      result.reminders = "lembretes desativados nas configurações";
    } else {
      const daysBefore = settings?.reminder_days_before ?? 3;
      const windowEnd = new Date(today);
      windowEnd.setDate(windowEnd.getDate() + daysBefore);
      const windowEndIso = windowEnd.toISOString().slice(0, 10);

      const { data: dueExpenses } = await supabase
        .from("expenses")
        .select(
          "id,title,due_date,expense_shares(id,amount,payment_status,member:household_members(name,email))",
        )
        .eq("household_id", householdId)
        .not("due_date", "is", null)
        .lte("due_date", windowEndIso)
        .in("status", ["planned", "open"]);

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://casa5.vercel.app";
      let sent = 0;

      for (const expense of dueExpenses ?? []) {
        const shares = expense.expense_shares ?? [];
        for (const share of shares) {
          if (!["pending", "late"].includes(share.payment_status)) continue;
          const member = Array.isArray(share.member) ? share.member[0] : share.member;
          if (!member?.email) continue;

          const { error: logError } = await supabase.from("expense_reminder_log").insert({
            expense_share_id: share.id,
            reminder_date: todayIso,
          });
          // unique(expense_share_id, reminder_date) já impede reenviar no mesmo dia
          if (logError) continue;

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
          } catch {
            // não interrompe o restante dos envios por causa de uma falha isolada
          }
        }
      }
      result.remindersSent = sent;
      result.reminders = `${sent} lembrete(s) enviado(s)`;
    }
  }

  await supabase.from("system_events").insert({
    household_id: householdId,
    event_type: "daily_automation",
    title: "Automação diária executada",
    detail: JSON.stringify(result),
    metadata: result
  });

  return NextResponse.json({ ok: true, date: todayIso, ...result });
}
