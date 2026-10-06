import type { SupabaseClient } from "@supabase/supabase-js";
import { todayIso } from "@/lib/chore-rotation";
import {
  dailyChoreReminderEmail,
  emailConfigured,
  sendEmail,
} from "@/lib/email";

export type DailyChoreReminderResult = {
  ok: boolean;
  sent: number;
  skippedAlreadySent: number;
  message: string;
};

const defaultTasks = [
  {
    label: "Retirar o lixo da cozinha",
    description: "Retire o saco e coloque um saco novo na lixeira.",
  },
  {
    label: "Verificar o lixo dos banheiros que utiliza",
    description: "Se alguma lixeira estiver cheia, retire o lixo e coloque um saco novo.",
  },
  {
    label: "Guardar as louças do seca-louças a partir das 19h",
    description: "Se ainda estiverem molhadas, seque todas as louças antes de guardar.",
  },
];

export async function runDailyChoreReminder(
  supabase: SupabaseClient,
  householdId: string,
): Promise<DailyChoreReminderResult> {
  if (!emailConfigured()) {
    return {
      ok: false,
      sent: 0,
      skippedAlreadySent: 0,
      message:
        "BREVO_API_KEY e um remetente em BREVO_FROM_EMAIL ou RESEND_FROM não estão configurados.",
    };
  }

  const reminderDate = todayIso();
  const { data: assignedMemberId, error: assignmentError } = await supabase.rpc(
    "daily_rotation_assignee",
    {
      target_household: householdId,
      assignment_date: reminderDate,
    },
  );
  if (assignmentError) {
    return {
      ok: false,
      sent: 0,
      skippedAlreadySent: 0,
      message: `Não foi possível consultar a escala: ${assignmentError.message}`,
    };
  }
  if (!assignedMemberId) {
    return {
      ok: true,
      sent: 0,
      skippedAlreadySent: 0,
      message: "A escala diária ainda não possui responsável para hoje.",
    };
  }

  const [{ data: member, error: memberError }, { data: taskRows, error: taskError }] =
    await Promise.all([
      supabase
        .from("household_members")
        .select("id,name,email")
        .eq("household_id", householdId)
        .eq("id", String(assignedMemberId))
        .eq("active", true)
        .maybeSingle(),
      supabase
        .from("daily_standard_tasks")
        .select("label,description")
        .eq("household_id", householdId)
        .eq("active", true)
        .order("display_order")
        .order("created_at"),
    ]);

  if (memberError || taskError) {
    return {
      ok: false,
      sent: 0,
      skippedAlreadySent: 0,
      message: memberError?.message ?? taskError?.message ?? "Falha ao preparar o lembrete.",
    };
  }
  if (!member?.email) {
    return {
      ok: false,
      sent: 0,
      skippedAlreadySent: 0,
      message: `${member?.name ?? "O responsável de hoje"} não possui e-mail cadastrado.`,
    };
  }

  let { data: log, error: logError } = await supabase
    .from("daily_chore_reminder_log")
    .insert({
      household_id: householdId,
      member_id: member.id,
      reminder_date: reminderDate,
      recipient_email: member.email,
    })
    .select("id")
    .single();

  if (logError?.code === "23505") {
    const { data: existing } = await supabase
      .from("daily_chore_reminder_log")
      .select("id,sent_at,created_at")
      .eq("household_id", householdId)
      .eq("member_id", member.id)
      .eq("reminder_date", reminderDate)
      .maybeSingle();

    if (existing?.sent_at) {
      return {
        ok: true,
        sent: 0,
        skippedAlreadySent: 1,
        message: `${member.name} já recebeu o lembrete de hoje.`,
      };
    }

    const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: released } = existing
      ? await supabase
          .from("daily_chore_reminder_log")
          .delete()
          .eq("id", existing.id)
          .is("sent_at", null)
          .lt("created_at", staleBefore)
          .select("id")
          .maybeSingle()
      : { data: null };

    if (!released) {
      return {
        ok: true,
        sent: 0,
        skippedAlreadySent: 1,
        message: `O lembrete de ${member.name} já está sendo processado.`,
      };
    }

    const retryReservation = await supabase
      .from("daily_chore_reminder_log")
      .insert({
        household_id: householdId,
        member_id: member.id,
        reminder_date: reminderDate,
        recipient_email: member.email,
      })
      .select("id")
      .single();
    log = retryReservation.data;
    logError = retryReservation.error;
  }
  if (logError || !log) {
    return {
      ok: false,
      sent: 0,
      skippedAlreadySent: 0,
      message: `Não foi possível reservar o envio: ${logError?.message ?? "erro desconhecido"}`,
    };
  }

  const tasks = taskRows?.length ? taskRows : defaultTasks;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://casa5.vercel.app";
  const { subject, html } = dailyChoreReminderEmail({
    memberName: member.name,
    reminderDate,
    tasks,
    appUrl,
  });

  try {
    const { messageId } = await sendEmail({
      to: member.email,
      subject,
      html,
      tags: ["casa5-rotina-diaria"],
    });
    const { error: updateError } = await supabase
      .from("daily_chore_reminder_log")
      .update({ message_id: messageId, sent_at: new Date().toISOString() })
      .eq("id", log.id);

    return {
      ok: !updateError,
      sent: 1,
      skippedAlreadySent: 0,
      message: updateError
        ? `O Brevo aceitou o e-mail, mas o log não foi finalizado: ${updateError.message}`
        : `Lembrete diário enviado para ${member.name}.`,
    };
  } catch (error) {
    await supabase.from("daily_chore_reminder_log").delete().eq("id", log.id);
    return {
      ok: false,
      sent: 0,
      skippedAlreadySent: 0,
      message: error instanceof Error ? error.message : "Falha desconhecida no envio.",
    };
  }
}
