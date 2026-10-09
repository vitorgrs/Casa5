import type { SupabaseClient } from "@supabase/supabase-js";
import { todayIso } from "@/lib/chore-rotation";
import {
  emailConfigurationError,
  emailConfigured,
  laundryReminderEmail,
  sendEmail,
} from "@/lib/email";
import {
  laundryAssignmentsForDate,
  laundryItemLabel,
  type LaundryRotationMember,
  type LaundryRotationOverride,
  type LaundryRotationVersion,
} from "@/lib/laundry-rotation";

export type DailyLaundryReminderResult = {
  ok: boolean;
  sent: number;
  skippedAlreadySent: number;
  failed: number;
  message: string;
};

type LaundryDuty = {
  key: string;
  label: string;
  description: string | null;
};

type ReminderMember = LaundryRotationMember & {
  email: string | null;
  active: boolean;
};

type SendOutcome = {
  sent: number;
  skipped: number;
  failed: number;
  detail: string | null;
};

function appendDuty(
  dutiesByMember: Map<string, LaundryDuty[]>,
  memberId: string,
  duty: LaundryDuty,
) {
  const duties = dutiesByMember.get(memberId) ?? [];
  if (!duties.some((existing) => existing.key === duty.key)) duties.push(duty);
  dutiesByMember.set(memberId, duties);
}

async function reserveLaundryReminder(
  supabase: SupabaseClient,
  householdId: string,
  member: ReminderMember,
  reminderDate: string,
  duties: LaundryDuty[],
) {
  let { data: log, error: logError } = await supabase
    .from("laundry_reminder_log")
    .insert({
      household_id: householdId,
      member_id: member.id,
      reminder_date: reminderDate,
      recipient_email: member.email,
      duties: duties.map(({ label, description }) => ({ label, description })),
    })
    .select("id")
    .single();

  if (logError?.code !== "23505") return { log, logError, skipped: false };

  const { data: existing, error: existingError } = await supabase
    .from("laundry_reminder_log")
    .select("id,sent_at,created_at")
    .eq("household_id", householdId)
    .eq("member_id", member.id)
    .eq("reminder_date", reminderDate)
    .maybeSingle();

  if (existingError) {
    return { log: null, logError: existingError, skipped: false };
  }

  if (existing?.sent_at) {
    return { log: null, logError: null, skipped: true };
  }

  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: released, error: releaseError } = existing
    ? await supabase
        .from("laundry_reminder_log")
        .delete()
        .eq("id", existing.id)
        .is("sent_at", null)
        .lt("created_at", staleBefore)
        .select("id")
        .maybeSingle()
    : { data: null, error: null };

  if (releaseError) {
    return { log: null, logError: releaseError, skipped: false };
  }
  if (existing && !released) {
    return { log: null, logError: null, skipped: true };
  }

  const retry = await supabase
    .from("laundry_reminder_log")
    .insert({
      household_id: householdId,
      member_id: member.id,
      reminder_date: reminderDate,
      recipient_email: member.email,
      duties: duties.map(({ label, description }) => ({ label, description })),
    })
    .select("id")
    .single();

  return { log: retry.data, logError: retry.error, skipped: false };
}

async function sendMemberLaundryReminder(
  supabase: SupabaseClient,
  householdId: string,
  member: ReminderMember,
  reminderDate: string,
  duties: LaundryDuty[],
): Promise<SendOutcome> {
  if (!member.active) {
    return {
      sent: 0,
      skipped: 0,
      failed: 1,
      detail: `${member.name} está inativo e não recebeu o lembrete.`,
    };
  }
  if (!member.email) {
    return {
      sent: 0,
      skipped: 0,
      failed: 1,
      detail: `${member.name} não possui e-mail cadastrado.`,
    };
  }

  const reservation = await reserveLaundryReminder(
    supabase,
    householdId,
    member,
    reminderDate,
    duties,
  );
  if (reservation.skipped) {
    return { sent: 0, skipped: 1, failed: 0, detail: null };
  }
  if (reservation.logError || !reservation.log) {
    return {
      sent: 0,
      skipped: 0,
      failed: 1,
      detail: `Não foi possível reservar o lembrete de ${member.name}: ${reservation.logError?.message ?? "erro desconhecido"}`,
    };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://casa5.vercel.app";
  const { subject, html } = laundryReminderEmail({
    memberName: member.name,
    reminderDate,
    duties,
    appUrl,
  });

  try {
    const { messageId } = await sendEmail({
      to: member.email,
      subject,
      html,
      tags: ["casa5-lavanderia"],
      idempotencyKey: `laundry:${reminderDate}:${member.id}`,
    });
    const { error: updateError } = await supabase
      .from("laundry_reminder_log")
      .update({ message_id: messageId, sent_at: new Date().toISOString() })
      .eq("id", reservation.log.id);

    return updateError
      ? {
          sent: 1,
          skipped: 0,
          failed: 1,
          detail: `O e-mail de ${member.name} foi aceito, mas o log não foi finalizado: ${updateError.message}`,
        }
      : { sent: 1, skipped: 0, failed: 0, detail: null };
  } catch (error) {
    await supabase
      .from("laundry_reminder_log")
      .delete()
      .eq("id", reservation.log.id);
    return {
      sent: 0,
      skipped: 0,
      failed: 1,
      detail:
        error instanceof Error
          ? `${member.name}: ${error.message}`
          : `${member.name}: falha desconhecida no envio.`,
    };
  }
}

export async function runDailyLaundryReminder(
  supabase: SupabaseClient,
  householdId: string,
): Promise<DailyLaundryReminderResult> {
  const reminderDate = todayIso();
  const [
    { data: versionRows, error: versionError },
    { data: versionMemberRows, error: versionMemberError },
    { data: overrideRows, error: overrideError },
    { data: collectiveRows, error: collectiveError },
    { data: memberRows, error: memberError },
  ] = await Promise.all([
    supabase
      .from("laundry_rotation_versions")
      .select("id,effective_from,anchor_date,anchor_member_id,gap_days,people_per_day,allow_incomplete_last_group,created_at")
      .eq("household_id", householdId)
      .order("effective_from"),
    supabase
      .from("laundry_rotation_version_members")
      .select("version_id,member_id,rotation_order,member_name,member_initials,member_color_key")
      .eq("household_id", householdId)
      .order("rotation_order"),
    supabase
      .from("laundry_rotation_overrides")
      .select("wash_date,member_id,resets_rotation,note,created_at")
      .eq("household_id", householdId)
      .lte("wash_date", reminderDate),
    supabase
      .from("laundry_collective_washes")
      .select("id,item_type,custom_label,note,responsible_member_id")
      .eq("household_id", householdId)
      .eq("wash_date", reminderDate)
      .not("responsible_member_id", "is", null),
    supabase
      .from("household_members")
      .select("id,name,email,initials,color_key,display_order,active")
      .eq("household_id", householdId)
      .order("display_order"),
  ]);

  const queryError =
    versionError ??
    versionMemberError ??
    overrideError ??
    collectiveError ??
    memberError;
  if (queryError) {
    return {
      ok: false,
      sent: 0,
      skippedAlreadySent: 0,
      failed: 1,
      message: `Não foi possível preparar os lembretes da lavanderia: ${queryError.message}`,
    };
  }

  const members: ReminderMember[] = (memberRows ?? []).map((member) => ({
    id: member.id,
    name: member.name,
    email: member.email,
    initials: member.initials,
    color_key: member.color_key,
    rotation_order: member.display_order,
    active: member.active,
  }));
  const membersById = new Map(members.map((member) => [member.id, member]));
  const versionMembersById = new Map<string, LaundryRotationMember[]>();
  for (const row of versionMemberRows ?? []) {
    const current = versionMembersById.get(row.version_id) ?? [];
    current.push({
      id: row.member_id,
      name: row.member_name,
      initials: row.member_initials,
      color_key: row.member_color_key,
      rotation_order: row.rotation_order,
    });
    versionMembersById.set(row.version_id, current);
  }
  const versions: LaundryRotationVersion[] = (versionRows ?? []).map(
    (version) => ({
      ...version,
      members: (versionMembersById.get(version.id) ?? []).sort(
        (first, second) => first.rotation_order - second.rotation_order,
      ),
    }),
  );
  const overrides = (overrideRows ?? []) as LaundryRotationOverride[];
  const dutiesByMember = new Map<string, LaundryDuty[]>();
  const assignment = laundryAssignmentsForDate(
    reminderDate,
    versions,
    overrides,
    members,
  );

  if (assignment) {
    for (const assigned of assignment.members) {
      const companions = assignment.members
        .filter((member) => member.id !== assigned.id)
        .map((member) => member.name)
        .join(" e ");
      appendDuty(dutiesByMember, assigned.id, {
        key: "resident_rotation",
        label: "Lavar suas roupas pessoais",
        description: companions
          ? `Você divide o dia da lavanderia com ${companions}.`
          : "O dia da lavanderia está reservado para você.",
      });
    }
  }

  for (const wash of collectiveRows ?? []) {
    if (!wash.responsible_member_id) continue;
    const itemLabel = laundryItemLabel(wash.item_type, wash.custom_label);
    appendDuty(dutiesByMember, wash.responsible_member_id, {
      key: `collective:${wash.id}`,
      label: `Lavar ${itemLabel.toLocaleLowerCase("pt-BR")}`,
      description:
        wash.note?.trim() || "Lavagem coletiva cadastrada pelo administrador.",
    });
  }

  if (dutiesByMember.size === 0) {
    return {
      ok: true,
      sent: 0,
      skippedAlreadySent: 0,
      failed: 0,
      message: "Não há moradores ou lavagens coletivas com responsável para hoje.",
    };
  }
  if (!emailConfigured()) {
    return {
      ok: false,
      sent: 0,
      skippedAlreadySent: 0,
      failed: dutiesByMember.size,
      message: emailConfigurationError(),
    };
  }

  const missingMembers = [...dutiesByMember.keys()].filter(
    (memberId) => !membersById.has(memberId),
  );
  const outcomes = await Promise.all(
    [...dutiesByMember.entries()].flatMap(([memberId, duties]) => {
      const member = membersById.get(memberId);
      return member
        ? [
            sendMemberLaundryReminder(
              supabase,
              householdId,
              member,
              reminderDate,
              duties,
            ),
          ]
        : [];
    }),
  );
  const sent = outcomes.reduce((total, outcome) => total + outcome.sent, 0);
  const skippedAlreadySent = outcomes.reduce(
    (total, outcome) => total + outcome.skipped,
    0,
  );
  const failed =
    missingMembers.length +
    outcomes.reduce((total, outcome) => total + outcome.failed, 0);
  const details = outcomes
    .map((outcome) => outcome.detail)
    .filter((detail): detail is string => Boolean(detail));
  if (missingMembers.length) {
    details.push(
      `${missingMembers.length} responsável(is) não foram encontrados no cadastro atual.`,
    );
  }

  const summary = `${sent} lembrete(s) da lavanderia enviado(s); ${skippedAlreadySent} já processado(s); ${failed} falha(s).`;
  return {
    ok: failed === 0,
    sent,
    skippedAlreadySent,
    failed,
    message: details.length ? `${summary} ${details.join(" ")}` : summary,
  };
}
