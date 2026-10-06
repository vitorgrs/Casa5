import { NextResponse } from "next/server";
import { todayIso } from "@/lib/chore-rotation";
import { runDailyChoreReminder } from "@/lib/chore-reminders";
import { runDailyLaundryReminder } from "@/lib/laundry-reminders";
import { createServiceClient } from "@/lib/supabase/service";
import { syncLatestMercadoPagoReport } from "@/lib/mercado-pago";
import { runExpenseReminders } from "@/lib/reminders";

// O plano Hobby com Fluid Compute aceita até 300 s. A folga evita interromper
// a sincronização externa e os e-mails quando as duas APIs estão mais lentas.
export const maxDuration = 300;

function firstDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const localTodayIso = todayIso();
  const today = new Date(`${localTodayIso}T12:00:00.000Z`);
  const householdId = "11111111-1111-1111-1111-111111111111";
  const result = {
    lateShares: 0,
    recurringCreated: 0,
    recurringFailed: 0,
    mercadoPago: "não executado",
    choreReminder: "não executado",
    laundryReminder: "não executado",
    remindersSent: 0,
    reminders: "não executado",
  };

  const { data: overdueExpenses } = await supabase
    .from("expenses")
    .select("id")
    .eq("household_id", householdId)
    .lt("due_date", localTodayIso)
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
    .select("reference_month,recurrence,series_id")
    .eq("household_id", householdId)
    .not("series_id", "is", null)
    .order("reference_month", { ascending: false });

  type RecurringExpense = NonNullable<typeof recurring>[number];
  const latestBySeries = new Map<string, RecurringExpense>();
  for (const expense of recurring ?? []) {
    if (!latestBySeries.has(expense.series_id!)) latestBySeries.set(expense.series_id!, expense);
  }

  for (const expense of latestBySeries.values()) {
    if (
      !expense ||
      expense.recurrence !== "monthly" ||
      expense.reference_month >= targetMonth
    ) continue;
    const { data: createdExpenseId, error } = await supabase.rpc(
      "create_recurring_expense_month",
      {
        target_household_id: householdId,
        target_series_id: expense.series_id,
        target_reference_month: targetMonth,
      },
    );
    if (error) {
      result.recurringFailed += 1;
    } else if (createdExpenseId) {
      result.recurringCreated += 1;
    }
  }

  const mercadoPagoRun = (async () => {
    if (!process.env.MERCADO_PAGO_ACCESS_TOKEN) return "não configurado";
    try {
      const mp = await syncLatestMercadoPagoReport(supabase, householdId, null);
      return mp.imported
        ? "relatório importado"
        : mp.requested
          ? "nova geração solicitada"
          : mp.latestTaskStatus === "pending"
            ? "relatório em processamento"
            : mp.latestReportReady
              ? "nenhum relatório novo"
              : mp.requestDetail ?? "nenhum arquivo pronto";
    } catch (error) {
      return error instanceof Error ? `erro: ${error.message}` : "erro desconhecido";
    }
  })();

  const [
    mercadoPagoResult,
    reminderResult,
    choreReminderResult,
    laundryReminderResult,
  ] = await Promise.all([
    mercadoPagoRun,
    runExpenseReminders(supabase, householdId),
    // Segunda chance: o log único impede duplicidade se o envio das 06:00
    // funcionou e permite tentar de novo se a chamada ao provedor falhou.
    runDailyChoreReminder(supabase, householdId),
    runDailyLaundryReminder(supabase, householdId),
  ]);
  result.mercadoPago = mercadoPagoResult;
  result.choreReminder = choreReminderResult.message;
  result.laundryReminder = laundryReminderResult.message;
  result.remindersSent = reminderResult.sent;
  result.reminders = reminderResult.message;

  await supabase.from("system_events").insert({
    household_id: householdId,
    event_type: "daily_automation",
    title: "Automação diária executada",
    detail: JSON.stringify(result),
    metadata: result
  });

  return NextResponse.json({ ok: true, date: localTodayIso, ...result });
}
