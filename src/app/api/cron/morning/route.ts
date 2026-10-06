import { NextResponse } from "next/server";
import { runDailyChoreReminder } from "@/lib/chore-reminders";
import { todayIso } from "@/lib/chore-rotation";
import { runDailyLaundryReminder } from "@/lib/laundry-reminders";
import { createServiceClient } from "@/lib/supabase/service";

export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const householdId = "11111111-1111-1111-1111-111111111111";
  const supabase = createServiceClient();
  const [choreReminder, laundryReminder] = await Promise.all([
    runDailyChoreReminder(supabase, householdId),
    runDailyLaundryReminder(supabase, householdId),
  ]);

  await supabase.from("system_events").insert({
    household_id: householdId,
    event_type: "daily_chore_reminder",
    title: "Lembretes da manhã processados",
    detail: `${choreReminder.message} ${laundryReminder.message}`,
    metadata: { choreReminder, laundryReminder },
  });

  return NextResponse.json({
    ok: choreReminder.ok && laundryReminder.ok,
    date: todayIso(),
    choreReminder,
    laundryReminder,
  });
}
