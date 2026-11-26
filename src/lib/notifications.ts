import type { SupabaseClient } from "@supabase/supabase-js";
import { todayIso } from "@/lib/chore-rotation";
import { loadLaundryDuties } from "@/lib/laundry-reminders";

export type AppNotification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
};

// Notificações lidas há mais tempo que isso são apagadas pela rotina diária
// para não ocupar o banco do plano gratuito.
const READ_NOTIFICATION_RETENTION_DAYS = 60;

/** Antes da migration 038 a tabela não existe: o contador fica zerado. */
export async function countUnreadNotifications(
  supabase: SupabaseClient,
  memberId: string | null,
) {
  if (!memberId) return 0;
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("member_id", memberId)
    .is("read_at", null);
  return error ? 0 : (count ?? 0);
}

type NotificationInsert = {
  household_id: string;
  member_id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string;
  dedupe_key: string;
};

export type DutySyncResult = {
  ok: boolean;
  skipped: boolean;
  created: number;
  message: string;
};

/**
 * Rotina diária das notificações, idempotente:
 * 1. passa a vez de quem está fora de casa nos rodízios por confirmação
 *    (apply_member_absences);
 * 2. avisa quem está na escala diária e na lavanderia hoje;
 * 3. apaga notificações lidas antigas.
 * Roda no cron da manhã e, como garantia, na primeira abertura do app no
 * dia. A tabela notification_sync_runs evita repetir o trabalho; a chave de
 * deduplicação das notificações evita avisos duplicados mesmo em corrida.
 */
export async function syncDailyDutyNotifications(
  service: SupabaseClient,
  householdId: string,
  { force = false }: { force?: boolean } = {},
): Promise<DutySyncResult> {
  const today = todayIso();

  if (!force) {
    const { data: existingRun, error: runError } = await service
      .from("notification_sync_runs")
      .select("run_date")
      .eq("household_id", householdId)
      .eq("run_date", today)
      .maybeSingle();
    if (runError) {
      return { ok: false, skipped: true, created: 0, message: runError.message };
    }
    if (existingRun) {
      return { ok: true, skipped: true, created: 0, message: "Rotina de hoje já executada." };
    }
  }

  const { error: absenceError } = await service.rpc("apply_member_absences", {
    target_household_id: householdId,
  });

  const notifications: NotificationInsert[] = [];

  const { data: dailyAssignee, error: dailyError } = await service.rpc(
    "daily_rotation_assignee",
    { target_household: householdId, assignment_date: today },
  );
  if (!dailyError && dailyAssignee) {
    notifications.push({
      household_id: householdId,
      member_id: String(dailyAssignee),
      kind: "duty_today",
      title: "Hoje é seu dia na escala da casa",
      body: "Confira as tarefas do dia e marque o que for concluído.",
      link: "/app/limpeza",
      dedupe_key: `duty:daily:${today}`,
    });
  }

  const laundry = await loadLaundryDuties(service, householdId, today);
  if (!("message" in laundry)) {
    for (const [memberId, duties] of laundry.dutiesByMember) {
      notifications.push({
        household_id: householdId,
        member_id: memberId,
        kind: "duty_today",
        title: "Hoje é seu dia na lavanderia",
        body: duties.map((duty) => duty.label).join(" • ").slice(0, 600),
        link: "/app/limpeza/lavanderia",
        dedupe_key: `duty:laundry:${today}`,
      });
    }
  }

  let created = 0;
  let insertError: string | null = null;
  if (notifications.length) {
    const { data, error } = await service
      .from("notifications")
      .upsert(notifications, {
        onConflict: "member_id,dedupe_key",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) insertError = error.message;
    created = data?.length ?? 0;
  }

  const retentionLimit = new Date(
    Date.now() - READ_NOTIFICATION_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  await service
    .from("notifications")
    .delete()
    .eq("household_id", householdId)
    .not("read_at", "is", null)
    .lt("created_at", retentionLimit);

  const problems = [
    absenceError && `ausências: ${absenceError.message}`,
    dailyError && `escala: ${dailyError.message}`,
    "message" in laundry && `lavanderia: ${laundry.message}`,
    insertError && `notificações: ${insertError}`,
  ].filter(Boolean);

  // Só marca o dia como concluído quando tudo deu certo, para a próxima
  // abertura do app tentar de novo em caso de falha.
  if (problems.length === 0) {
    await service
      .from("notification_sync_runs")
      .upsert({ household_id: householdId, run_date: today }, { onConflict: "household_id,run_date" });
  }

  return {
    ok: problems.length === 0,
    skipped: false,
    created,
    message: problems.length
      ? `Rotina de notificações com falha (${problems.join("; ")}).`
      : `${created} aviso(s) de rodízio criado(s).`,
  };
}
