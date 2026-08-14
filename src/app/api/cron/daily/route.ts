import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { syncLatestMercadoPagoReport } from "@/lib/mercado-pago";
import { runExpenseReminders } from "@/lib/reminders";

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
      result.mercadoPago = mp.imported
        ? "relatório importado"
        : mp.requested
          ? "nova geração solicitada"
          : mp.latestTaskStatus === "pending"
            ? "relatório em processamento"
            : mp.latestReportReady
              ? "nenhum relatório novo"
              : mp.requestDetail ?? "nenhum arquivo pronto";
    } catch (error) {
      result.mercadoPago = error instanceof Error ? `erro: ${error.message}` : "erro desconhecido";
    }
  }

  const reminderResult = await runExpenseReminders(supabase, householdId);
  result.remindersSent = reminderResult.sent;
  result.reminders = reminderResult.message;

  await supabase.from("system_events").insert({
    household_id: householdId,
    event_type: "daily_automation",
    title: "Automação diária executada",
    detail: JSON.stringify(result),
    metadata: result
  });

  return NextResponse.json({ ok: true, date: todayIso, ...result });
}
