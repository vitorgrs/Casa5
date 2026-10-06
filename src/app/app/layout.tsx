import { AppShell } from "@/components/app-shell";
import { requireActiveProfile } from "@/lib/auth";
import { addDays, todayIso } from "@/lib/chore-rotation";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { profile, supabase } = await requireActiveProfile();
  const today = todayIso();
  const soon = addDays(today, 5);
  const { count } = await supabase
    .from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("household_id", profile.household_id)
    .not("due_date", "is", null)
    .lte("due_date", soon)
    .in("status", ["planned", "open"])
    .gte("due_date", today);

  return <AppShell profile={profile} alertCount={count ?? 0}>{children}</AppShell>;
}
