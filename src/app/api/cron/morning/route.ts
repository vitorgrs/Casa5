import { NextResponse } from "next/server";
import { runDailyChoreReminder } from "@/lib/chore-reminders";
import { todayIso } from "@/lib/chore-rotation";
import { runDailyLaundryReminder } from "@/lib/laundry-reminders";
import { createServiceClient } from "@/lib/supabase/service";

// Cada chamada ao provedor tem timeout de 15 s; 60 s deixa margem para as
// consultas e para finalizar os logs sem manter a função aberta indefinidamente.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/morning] CRON_SECRET não configurado.");
    return NextResponse.json({ error: "Cron indisponível" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  try {
    const householdId = "11111111-1111-1111-1111-111111111111";
    const supabase = createServiceClient();
    const [choreReminder, laundryReminder] = await Promise.all([
      runDailyChoreReminder(supabase, householdId),
      runDailyLaundryReminder(supabase, householdId),
    ]);
    const ok = choreReminder.ok && laundryReminder.ok;

    const { error: eventError } = await supabase.from("system_events").insert({
      household_id: householdId,
      event_type: "daily_chore_reminder",
      title: ok
        ? "Lembretes da manhã processados"
        : "Lembretes da manhã com falha",
      detail: `${choreReminder.message} ${laundryReminder.message}`,
      metadata: { ok, choreReminder, laundryReminder },
    });
    if (eventError) {
      throw new Error(`Não foi possível registrar a execução: ${eventError.message}`);
    }

    return NextResponse.json(
      {
        ok,
        date: todayIso(),
        choreReminder,
        laundryReminder,
      },
      { status: ok ? 200 : 500 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Falha desconhecida no cron da manhã.";
    console.error("[cron/morning]", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
