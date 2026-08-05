"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";

function destination(formData: FormData, fallback: string) {
  const value = String(formData.get("redirect_to") ?? "");
  return value.startsWith("/app") ? value : fallback;
}

function pathOf(url: string) {
  return url.split("?")[0] || "/app";
}

function money(value: FormDataEntryValue | null): number | null {
  let text = String(value ?? "")
    .trim()
    .replace(/\s/g, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function firstDay(value: string) {
  return /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
}

function makeShares(
  formData: FormData,
  amount: number | null,
  mode: string,
  allowCustomMismatch: boolean,
) {
  const memberIds = formData.getAll("members").map(String);
  if (!amount || memberIds.length === 0) return [];

  if (mode === "custom") {
    const shares = memberIds.map((memberId) => ({
      member_id: memberId,
      amount: money(formData.get(`share_${memberId}`)) ?? 0,
    }));
    const total = shares.reduce((sum, share) => sum + share.amount, 0);
    if (Math.abs(total - amount) > 0.01 && !allowCustomMismatch) {
      throw new Error(
        `A divisão personalizada soma R$ ${total.toFixed(2)}, mas a despesa é R$ ${amount.toFixed(2)}.`,
      );
    }
    return shares;
  }

  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / memberIds.length);
  let remainder = cents - base * memberIds.length;
  return memberIds.map((memberId) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { member_id: memberId, amount: (base + extra) / 100 };
  });
}

export async function createExpense(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requireAdmin();
  const title = String(formData.get("title") ?? "").trim();
  const amount = money(formData.get("amount"));
  const splitMode = String(formData.get("split_mode") ?? "equal");
  const recurrence = String(formData.get("recurrence") ?? "once");
  const allowCustomMismatch =
    String(formData.get("allow_custom_mismatch") ?? "0") === "1";
  const shares = makeShares(formData, amount, splitMode, allowCustomMismatch);

  // Campos de reembolso
  const refundExists = formData.get("refund_exists") === "on";
  const refundTotalAmount = money(formData.get("refund_total_amount"));
  const refundDescription = String(formData.get("refund_description") ?? "") || null;
  const refundResponsibleEntity = String(formData.get("refund_responsible_entity") ?? "") || null;
  const refundDueDate = String(formData.get("refund_due_date") ?? "") || null;
  const refundReference = String(formData.get("refund_reference") ?? "") || null;

  const { data: expense, error } = await supabase
    .from("expenses")
    .insert({
      household_id: profile.household_id,
      title,
      category: String(formData.get("category") ?? "Outros"),
      description: String(formData.get("description") ?? "") || null,
      reference_month: firstDay(String(formData.get("reference_month") ?? "")),
      due_date: String(formData.get("due_date") ?? "") || null,
      amount,
      estimated: formData.get("estimated") === "on",
      split_mode: splitMode,
      status: amount === null ? "planned" : "open",
      recurrence,
      series_id: recurrence === "monthly" ? crypto.randomUUID() : null,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error || !expense)
    throw new Error(error?.message ?? "Não foi possível criar a despesa.");

  if (shares.length) {
    const { error: shareError } = await supabase
      .from("expense_shares")
      .insert(shares.map((share) => ({ ...share, expense_id: expense.id })));
    if (shareError) throw new Error(shareError.message);
  }

  // Criar reembolso se solicitado
  if (refundExists) {
    const { data: refund, error: refundError } = await supabase
      .from("expense_refunds")
      .insert({
        expense_id: expense.id,
        household_id: profile.household_id,
        total_amount: refundTotalAmount,
        description: refundDescription,
        responsible_entity: refundResponsibleEntity,
        due_date: refundDueDate,
        reference: refundReference,
        status: 'a_solicitar',
        requested_by: profile.id,
        created_by: profile.id,
        updated_by: profile.id,
      })
      .select("id")
      .single();

    if (refundError || !refund)
      throw new Error(refundError?.message ?? "Não foi possível criar o reembolso.");

    // Registrar evento de sistema para o reembolso solicitado
    await supabase.from("system_events").insert({
      household_id: profile.household_id,
      event_type: 'refund_solicited',
      title: `Reembolso solicitado: ${title}`,
      detail: `R$ ${refundTotalAmount?.toFixed(2)} para ${refundResponsibleEntity || 'entidade responsável'}`, metadata: {
        expense_id: expense.id,
        refund_id: refund.id,
        created_by: profile.id,
      },
      created_by: profile.id,
    });
  }

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function updateExpense(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requireAdmin();
  const expenseId = String(formData.get("expense_id"));
  const amount = money(formData.get("amount"));
  const splitMode = String(formData.get("split_mode") ?? "equal");
  const allowCustomMismatch =
    String(formData.get("allow_custom_mismatch") ?? "0") === "1";
  const shares = makeShares(formData, amount, splitMode, allowCustomMismatch);

  const [{ data: currentShares }, { data: currentExpense }] = await Promise.all(
    [
      supabase
        .from("expense_shares")
        .select("member_id,payment_status,paid_at,payment_method,note")
        .eq("expense_id", expenseId),
      supabase
        .from("expenses")
        .select("series_id")
        .eq("id", expenseId)
        .single(),
    ],
  );
  type PreviousShare = {
    member_id: string;
    payment_status: string;
    paid_at: string | null;
    payment_method: string | null;
    note: string | null;
  };
  const previous = new Map<string, PreviousShare>(
    (currentShares ?? []).map((share: PreviousShare) => [
      share.member_id,
      share,
    ]),
  );

  const { error } = await supabase
    .from("expenses")
    .update({
      title: String(formData.get("title") ?? "").trim(),
      category: String(formData.get("category") ?? "Outros"),
      description: String(formData.get("description") ?? "") || null,
      reference_month: firstDay(String(formData.get("reference_month") ?? "")),
      due_date: String(formData.get("due_date") ?? "") || null,
      amount,
      estimated: formData.get("estimated") === "on",
      split_mode: splitMode,
      status: amount === null ? "planned" : "open",
      recurrence: String(formData.get("recurrence") ?? "once"),
      series_id:
        String(formData.get("recurrence") ?? "once") === "monthly"
          ? (currentExpense?.series_id ?? crypto.randomUUID())
          : currentExpense?.series_id,
    })
    .eq("id", expenseId)
    .eq("household_id", profile.household_id);

  if (error) throw new Error(error.message);
  await supabase.from("expense_shares").delete().eq("expense_id", expenseId);

  if (shares.length) {
    const { error: shareError } = await supabase.from("expense_shares").insert(
      shares.map((share) => {
        const old = previous.get(share.member_id);
        return {
          ...share,
          expense_id: expenseId,
          payment_status: old?.payment_status ?? "pending",
          paid_at: old?.paid_at ?? null,
          payment_method: old?.payment_method ?? null,
          note: old?.note ?? null,
        };
      }),
    );
    if (shareError) throw new Error(shareError.message);
  }

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function setPaymentStatus(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requireAdmin();
  const shareId = String(formData.get("share_id"));
  const status = String(formData.get("status"));
  const { data: changed, error } = await supabase
    .from("expense_shares")
    .update({
      payment_status: status,
      paid_at: status === "paid" ? new Date().toISOString() : null,
      payment_method: status === "paid" ? "Mercado Pago / Pix" : null,
    })
    .eq("id", shareId)
    .select("expense_id")
    .single();
  if (error || !changed)
    throw new Error(error?.message ?? "Pagamento não encontrado.");

  const { data: shares } = await supabase
    .from("expense_shares")
    .select("payment_status")
    .eq("expense_id", changed.expense_id);
  const settled =
    (shares ?? []).length > 0 &&
    (shares ?? []).every((share) =>
      ["paid", "waived"].includes(share.payment_status),
    );
  await supabase
    .from("expenses")
    .update({ status: settled ? "paid" : "open" })
    .eq("id", changed.expense_id);

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function deleteExpense(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requireAdmin();
  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("id", String(formData.get("expense_id")))
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function updateRefundStatus(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requireAdmin();
  const refundId = String(formData.get("refund_id"));
  const status = String(formData.get("status"));
  const receivedAmount = money(formData.get("received_amount"));
  const receivedAt = String(formData.get("received_at") ?? "") || null;
  const distributedAt = String(formData.get("distributed_at") ?? "") || null;
  const note = String(formData.get("note") ?? "") || null;

  const updateData: any = {
    status,
    updated_by: profile.id,
  };

  if (status === "solicitado" && receivedAt) updateData.requested_at = receivedAt;
  if (status === "recebido" || status === "distribuido") {
    if (receivedAmount) updateData.received_amount = receivedAmount;
    if (receivedAt) updateData.received_at = receivedAt;
  }
  if (status === "distribuido" && distributedAt) updateData.distributed_at = distributedAt;

  if (note) updateData.note = note;

  const { error } = await supabase
    .from("expense_refunds")
    .update(updateData)
    .eq("id", refundId)
    .eq("household_id", profile.household_id);

  if (error) throw new Error(error.message);

  // Registrar evento de sistema para a mudança de status
  const { data: refund } = await supabase
    .from("expense_refunds")
    .select("expense_id")
    .eq("id", refundId)
    .single();

  if (refund) {
    await supabase.from("system_events").insert({
      household_id: profile.household_id,
      event_type: `refund_${status}`,
      title: `Reembolso ${status}: ID ${refundId.substring(0, 8)}`,
      detail: status,
      metadata: { expense_id: refund.expense_id, refund_id: refundId, updated_by: profile.id },
      created_by: profile.id,
    });
  }

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}
