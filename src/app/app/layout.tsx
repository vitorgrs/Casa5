import { AppShell } from "@/components/app-shell";
import { requireActiveProfile } from "@/lib/auth";
import { countUnreadNotifications, syncDailyDutyNotifications } from "@/lib/notifications";
import { createServiceClient } from "@/lib/supabase/service";

// Intervalo mínimo entre tentativas na mesma instância do servidor. Depois
// que a rotina do dia termina, cada tentativa custa uma única consulta; o
// intervalo evita repetir a rotina inteira a cada página quando ela falha.
const RETRY_INTERVAL_MS = 10 * 60_000;
let lastAttemptAt = 0;

// Garante a rotina diária mesmo se o cron da manhã falhar. Erros aqui nunca
// impedem a navegação: o app abre normalmente e tenta de novo depois.
async function ensureDailyNotifications(householdId: string | null) {
  if (!householdId) return;
  if (Date.now() - lastAttemptAt < RETRY_INTERVAL_MS) return;
  lastAttemptAt = Date.now();
  try {
    await syncDailyDutyNotifications(createServiceClient(), householdId);
  } catch (error) {
    console.error("[notificações] rotina diária não executada", error);
  }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { profile, supabase } = await requireActiveProfile();
  await ensureDailyNotifications(profile.household_id);
  const unreadCount = await countUnreadNotifications(supabase, profile.member_id);

  return (
    <AppShell profile={profile} unreadCount={unreadCount}>
      {children}
    </AppShell>
  );
}
