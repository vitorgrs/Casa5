import { NextResponse } from "next/server";
import { todayIso } from "@/lib/chore-rotation";
import { runDailyChoreReminder } from "@/lib/chore-reminders";
import { runDailyLaundryReminder } from "@/lib/laundry-reminders";
import { createServiceClient } from "@/lib/supabase/service";
import { syncLatestMercadoPagoReport } from "@/lib/mercado-pago";
import { runExpenseReminders } from "@/lib/reminders";

// Com Fluid Compute, a função pode usar até 300 s. A folga evita interromper
// sincronizações externas e e-mails quando as APIs estão mais lentas.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function firstDay(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/daily] CRON_SECRET não configurado.");
    return NextResponse.json({ error: "Cron indisponível" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  try {
    const supabase = createServiceClient();
    const localTodayIso = todayIso();
    const today = new Date(`${localTodayIso}T12:00:00.000Z`);
    const householdId = "11111111-1111-1111-1111-111111111111";
    const result = {
      lateShares: 0,
      recurringCreated: 0,
      recurringFailed: 0,
      recurringError: null as string | null,
      mercadoPago: "não executado",
      choreReminder: "não executado",
      laundryReminder: "não executado",
      remindersSent: 0,
      reminders: "não executado",
    };

    const { data: overdueExpenses, error: overdueError } = await supabase
      .from("expenses")
      .select("id")
      .eq("household_id", householdId)
      .lt("due_date", localTodayIso)
      .in("status", ["planned", "open"]);
    if (overdueError) {
      throw new Error(`Falha ao consultar despesas vencidas: ${overdueError.message}`);
    }

    const overdueIds = (overdueExpenses ?? []).map((expense) => expense.id);
    if (overdueIds.length) {
      const { data: late, error: lateError } = await supabase
        .from("expense_shares")
        .update({ payment_status: "late" })
        .in("expense_id", overdueIds)
        .eq("payment_status", "pending")
        .select("id");
      if (lateError) {
        throw new Error(`Falha ao atualizar parcelas vencidas: ${lateError.message}`);
      }
      result.lateShares = late?.length ?? 0;
    }

    const target = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth() + (today.getUTCDate() >= 20 ? 1 : 0),
        1,
      ),
    );
    const targetMonth = firstDay(target);
    const { data: recurring, error: recurringQueryError } = await supabase
      .from("expenses")
      .select("reference_month,recurrence,series_id")
      .eq("household_id", householdId)
      .not("series_id", "is", null)
      .order("reference_month", { ascending: false });
    if (recurringQueryError) {
      throw new Error(
        `Falha ao consultar despesas recorrentes: ${recurringQueryError.message}`,
      );
    }

    type RecurringExpense = NonNullable<typeof recurring>[number];
    const latestBySeries = new Map<string, RecurringExpense>();
    for (const expense of recurring ?? []) {
      if (!latestBySeries.has(expense.series_id!)) {
        latestBySeries.set(expense.series_id!, expense);
      }
    }

    for (const expense of latestBySeries.values()) {
      if (
        !expense ||
        expense.recurrence !== "monthly" ||
        expense.reference_month >= targetMonth
      ) {
        continue;
      }
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
        result.recurringError ??= error.message;
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
      // Segunda chance: os logs impedem duplicidade quando o envio das 06:00
      // funcionou e liberam nova tentativa quando o provedor falhou.
      runDailyChoreReminder(supabase, householdId),
      runDailyLaundryReminder(supabase, householdId),
    ]);
    result.mercadoPago = mercadoPagoResult;
    result.choreReminder = choreReminderResult.message;
    result.laundryReminder = laundryReminderResult.message;
    result.remindersSent = reminderResult.sent;
    result.reminders = reminderResult.message;

    const ok =
      result.recurringFailed === 0 &&
      !mercadoPagoResult.startsWith("erro") &&
      reminderResult.ok &&
      choreReminderResult.ok &&
      laundryReminderResult.ok;
    const metadata = { ok, ...result };
    const { error: eventError } = await supabase.from("system_events").insert({
      household_id: householdId,
      event_type: "daily_automation",
      title: ok ? "Automação diária executada" : "Automação diária com falha",
      detail: JSON.stringify(metadata),
      metadata,
    });
    if (eventError) {
      throw new Error(`Não foi possível registrar a execução: ${eventError.message}`);
    }

    return NextResponse.json(
      { ok, date: localTodayIso, ...result },
      { status: ok ? 200 : 500 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Falha desconhecida no cron diário.";
    console.error("[cron/daily]", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
