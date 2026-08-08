"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { can, requireActiveProfile, requireAdmin, requirePermission } from "@/lib/auth";
import { deleteFromReceiptBucket, uploadToReceiptBucket } from "@/lib/storage";

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
  const { profile, supabase } = await requirePermission("manage_expenses");
  const title = String(formData.get("title") ?? "").trim();
  const amount = money(formData.get("amount"));
  const splitMode = String(formData.get("split_mode") ?? "equal");
  const recurrence = String(formData.get("recurrence") ?? "once");
  const allowCustomMismatch =
    String(formData.get("allow_custom_mismatch") ?? "0") === "1";
  const shares = makeShares(formData, amount, splitMode, allowCustomMismatch);
  const hasReimbursement = formData.get("has_reimbursement") === "on";
  const reimbursementAmount = hasReimbursement
    ? money(formData.get("reimbursement_amount"))
    : null;
  const dueDate = String(formData.get("due_date") ?? "") || null;

  const { data: expense, error } = await supabase
    .from("expenses")
    .insert({
      household_id: profile.household_id,
      title,
      category: String(formData.get("category") ?? "Outros"),
      description: String(formData.get("description") ?? "") || null,
      reference_month: firstDay(String(formData.get("reference_month") ?? "")),
      due_date: dueDate,
      amount,
      estimated: formData.get("estimated") === "on",
      split_mode: splitMode,
      status: amount === null ? "planned" : "open",
      recurrence,
      series_id: recurrence === "monthly" ? crypto.randomUUID() : null,
      has_reimbursement: hasReimbursement,
      reimbursement_amount: reimbursementAmount,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error || !expense)
    throw new Error(error?.message ?? "Não foi possível criar a despesa.");
  if (shares.length) {
    const { error: shareError } = await supabase.from("expense_shares").insert(
      shares.map((share) => ({
        ...share,
        expense_id: expense.id,
        reimbursement_status: hasReimbursement ? "pending" : "not_applicable",
      })),
    );
    if (shareError) throw new Error(shareError.message);
  }

  if (hasReimbursement && shares.length) {
    await supabase.from("tasks").insert({
      household_id: profile.household_id,
      scope: "geral",
      title: `Pedir reembolso: ${title}`,
      description: `Reembolso de R$ ${(reimbursementAmount ?? 0).toFixed(2)} por pessoa referente à despesa "${title}".`,
      due_date: dueDate,
      source: "reimbursement",
      source_expense_id: expense.id,
      created_by: profile.id,
    });
  }

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function updateExpense(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requirePermission("manage_expenses");
  const expenseId = String(formData.get("expense_id"));
  const amount = money(formData.get("amount"));
  const splitMode = String(formData.get("split_mode") ?? "equal");
  const allowCustomMismatch =
    String(formData.get("allow_custom_mismatch") ?? "0") === "1";
  const shares = makeShares(formData, amount, splitMode, allowCustomMismatch);
  const hasReimbursement = formData.get("has_reimbursement") === "on";
  const reimbursementAmount = hasReimbursement
    ? money(formData.get("reimbursement_amount"))
    : null;
  const title = String(formData.get("title") ?? "").trim();
  const dueDate = String(formData.get("due_date") ?? "") || null;

  const [{ data: currentShares }, { data: currentExpense }] = await Promise.all(
    [
      supabase
        .from("expense_shares")
        .select("member_id,payment_status,paid_at,payment_method,note,reimbursement_status,reimbursement_paid_at")
        .eq("expense_id", expenseId),
      supabase
        .from("expenses")
        .select("series_id,has_reimbursement")
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
    reimbursement_status: string;
    reimbursement_paid_at: string | null;
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
      title,
      category: String(formData.get("category") ?? "Outros"),
      description: String(formData.get("description") ?? "") || null,
      reference_month: firstDay(String(formData.get("reference_month") ?? "")),
      due_date: dueDate,
      amount,
      estimated: formData.get("estimated") === "on",
      split_mode: splitMode,
      status: amount === null ? "planned" : "open",
      recurrence: String(formData.get("recurrence") ?? "once"),
      series_id:
        String(formData.get("recurrence") ?? "once") === "monthly"
          ? (currentExpense?.series_id ?? crypto.randomUUID())
          : currentExpense?.series_id,
      has_reimbursement: hasReimbursement,
      reimbursement_amount: reimbursementAmount,
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
          reimbursement_status: hasReimbursement
            ? (old?.reimbursement_status && old.reimbursement_status !== "not_applicable"
                ? old.reimbursement_status
                : "pending")
            : "not_applicable",
          reimbursement_paid_at: hasReimbursement ? (old?.reimbursement_paid_at ?? null) : null,
        };
      }),
    );
    if (shareError) throw new Error(shareError.message);
  }

  // Se o reembolso acabou de ser ativado nesta edição, cria a tarefa de cobrança.
  if (hasReimbursement && !currentExpense?.has_reimbursement && shares.length) {
    await supabase.from("tasks").insert({
      household_id: profile.household_id,
      scope: "geral",
      title: `Pedir reembolso: ${title}`,
      description: `Reembolso de R$ ${(reimbursementAmount ?? 0).toFixed(2)} por pessoa referente à despesa "${title}".`,
      due_date: dueDate,
      source: "reimbursement",
      source_expense_id: expenseId,
      created_by: profile.id,
    });
  }

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function setPaymentStatus(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requirePermission("mark_expenses_paid");
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

export async function setReimbursementStatus(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requirePermission("mark_expenses_paid");
  const shareId = String(formData.get("share_id"));
  const status = String(formData.get("status"));
  const { error } = await supabase
    .from("expense_shares")
    .update({
      reimbursement_status: status,
      reimbursement_paid_at: status === "paid" ? new Date().toISOString() : null,
    })
    .eq("id", shareId)
    .neq("reimbursement_status", "not_applicable");
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

// ----------------------------------------------------------------------
// Comprovantes de pagamento (por morador) e boleto (por despesa)
// ----------------------------------------------------------------------

export async function uploadShareReceipt(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requireActiveProfile();
  const shareId = String(formData.get("share_id"));
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Selecione um arquivo (PDF ou foto) antes de enviar.");
  }

  const { data: share } = await supabase
    .from("expense_shares")
    .select("id,member_id,receipt_path,expense:expenses(household_id)")
    .eq("id", shareId)
    .single();
  if (!share) throw new Error("Parcela não encontrada.");
  const expense = Array.isArray(share.expense) ? share.expense[0] : share.expense;
  if (!expense || expense.household_id !== profile.household_id) {
    throw new Error("Parcela não pertence à sua casa.");
  }

  const isOwner = profile.member_id === share.member_id;
  const canManage = isOwner || can(profile, "manage_expenses") || can(profile, "mark_expenses_paid");
  if (!canManage) throw new Error("Você não pode anexar comprovante para outro morador.");

  const uploaded = await uploadToReceiptBucket(
    supabase,
    profile.household_id!,
    `shares/${shareId}`,
    file,
  );

  if (share.receipt_path) await deleteFromReceiptBucket(supabase, share.receipt_path);

  const { error } = await supabase
    .from("expense_shares")
    .update({
      receipt_path: uploaded.path,
      receipt_name: uploaded.name,
      receipt_uploaded_by: profile.id,
      receipt_uploaded_at: new Date().toISOString(),
    })
    .eq("id", shareId);
  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent("Comprovante enviado.")}`);
}

export async function deleteShareReceipt(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requirePermission("manage_expenses");
  const shareId = String(formData.get("share_id"));
  const { data: share } = await supabase
    .from("expense_shares")
    .select("receipt_path")
    .eq("id", shareId)
    .single();
  if (share?.receipt_path) await deleteFromReceiptBucket(supabase, share.receipt_path);
  const { error } = await supabase
    .from("expense_shares")
    .update({ receipt_path: null, receipt_name: null, receipt_uploaded_by: null, receipt_uploaded_at: null })
    .eq("id", shareId);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function uploadExpenseBoleto(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requirePermission("manage_expenses");
  const expenseId = String(formData.get("expense_id"));
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Selecione um arquivo (PDF ou foto) antes de enviar.");
  }

  const { data: expense } = await supabase
    .from("expenses")
    .select("id,household_id,boleto_path")
    .eq("id", expenseId)
    .single();
  if (!expense || expense.household_id !== profile.household_id) {
    throw new Error("Despesa não encontrada.");
  }

  const uploaded = await uploadToReceiptBucket(
    supabase,
    profile.household_id!,
    `expenses/${expenseId}`,
    file,
  );
  if (expense.boleto_path) await deleteFromReceiptBucket(supabase, expense.boleto_path);

  const { error } = await supabase
    .from("expenses")
    .update({ boleto_path: uploaded.path, boleto_name: uploaded.name, boleto_uploaded_at: new Date().toISOString() })
    .eq("id", expenseId);
  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent("Boleto anexado.")}`);
}

export async function deleteExpenseBoleto(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requirePermission("manage_expenses");
  const expenseId = String(formData.get("expense_id"));
  const { data: expense } = await supabase
    .from("expenses")
    .select("boleto_path")
    .eq("id", expenseId)
    .single();
  if (expense?.boleto_path) await deleteFromReceiptBucket(supabase, expense.boleto_path);
  const { error } = await supabase
    .from("expenses")
    .update({ boleto_path: null, boleto_name: null, boleto_uploaded_at: null })
    .eq("id", expenseId);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}
