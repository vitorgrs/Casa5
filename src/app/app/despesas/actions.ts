"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { can, requireActiveProfile, requireAdmin, requirePermission } from "@/lib/auth";
import type { FormActionState } from "@/lib/form-action-state";
import {
  deleteFromReceiptBucket,
  RECEIPT_BUCKET,
  slugifyReceiptFileName,
  validateReceiptMetadata,
  validateStoredReceiptMetadata,
} from "@/lib/storage";
import { createServiceClient } from "@/lib/supabase/service";

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

async function saveExpenseRecord(
  formData: FormData,
  expenseId: string | null,
) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requirePermission("manage_expenses");
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

  if (!title) throw new Error("Informe o nome da despesa.");
  if (amount !== null && amount < 0) {
    throw new Error("O valor da despesa não pode ser negativo.");
  }
  if (!['equal', 'custom'].includes(splitMode)) {
    throw new Error("Tipo de divisão inválido.");
  }
  if (!['once', 'monthly'].includes(recurrence)) {
    throw new Error("Recorrência inválida.");
  }
  if (hasReimbursement && (reimbursementAmount === null || reimbursementAmount <= 0)) {
    throw new Error("Informe um valor de reembolso maior que zero.");
  }
  const referenceMonth = firstDay(
    String(formData.get("reference_month") ?? ""),
  );
  if (!/^\d{4}-\d{2}-01$/.test(referenceMonth)) {
    throw new Error("Informe um mês de referência válido.");
  }

  const { error } = await supabase.rpc("save_expense_with_shares", {
    target_expense_id: expenseId,
    expense_title: title,
    expense_category: String(formData.get("category") ?? "Outros"),
    expense_description:
      String(formData.get("description") ?? "").trim() || null,
    expense_reference_month: referenceMonth,
    expense_due_date: dueDate,
    expense_amount: amount,
    expense_estimated: formData.get("estimated") === "on",
    expense_split_mode: splitMode,
    expense_recurrence: recurrence,
    expense_has_reimbursement: hasReimbursement,
    expense_reimbursement_amount: reimbursementAmount,
    allow_share_mismatch: allowCustomMismatch,
    share_values: shares,
  });
  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  revalidatePath("/app");
  revalidatePath("/app/eu");
  return { returnTo };
}

export async function createExpense(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  try {
    await saveExpenseRecord(formData, null);
    return { status: "success", message: "Despesa criada com sucesso." };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível criar a despesa.",
    };
  }
}

export async function updateExpense(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  try {
    await saveExpenseRecord(formData, String(formData.get("expense_id") ?? ""));
    return { status: "success", message: "Despesa atualizada com sucesso." };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível atualizar a despesa.",
    };
  }
}

export async function setPaymentStatus(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requirePermission("mark_expenses_paid");
  const shareId = String(formData.get("share_id"));
  const status = String(formData.get("status"));
  if (!["paid", "pending"].includes(status)) {
    throw new Error("Status de pagamento inválido.");
  }

  const { error } = await supabase.rpc("set_expense_share_payment", {
    target_share_id: shareId,
    target_status: status,
    target_paid_amount: null,
    record_as_admin: false,
  });
  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function setExpensePaymentAsAdmin(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requireAdmin();
  const shareId = String(formData.get("share_id") ?? "");
  const status = String(formData.get("status") ?? "paid");
  const paidAmount = money(formData.get("paid_amount"));

  if (!shareId || !["paid", "pending"].includes(status)) {
    throw new Error("Pagamento inválido.");
  }
  if (status === "paid" && (paidAmount === null || paidAmount <= 0)) {
    throw new Error("Informe um valor pago maior que zero.");
  }

  const { error } = await supabase.rpc("set_expense_share_payment", {
    target_share_id: shareId,
    target_status: status,
    target_paid_amount: status === "paid" ? paidAmount : null,
    record_as_admin: true,
  });
  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  revalidatePath("/app");
  revalidatePath("/app/eu");
  const separator = returnTo.includes("?") ? "&" : "?";
  const message =
    status === "paid"
      ? `Pagamento de R$ ${paidAmount!.toFixed(2).replace(".", ",")} registrado pelo administrador.`
      : "Pagamento desfeito pelo administrador.";
  redirect(`${returnTo}${separator}success=${encodeURIComponent(message)}`);
}

export async function deleteExpense(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requireAdmin();
  const expenseId = String(formData.get("expense_id"));
  const { data: expense } = await supabase
    .from("expenses")
    .select(
      "boleto_path,payment_receipt_path,expense_shares(receipt_path)",
    )
    .eq("id", expenseId)
    .eq("household_id", profile.household_id)
    .single();
  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("id", expenseId)
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  const attachmentPaths = Array.from(
    new Set(
      [
        expense?.boleto_path,
        expense?.payment_receipt_path,
        ...(expense?.expense_shares ?? []).map((share) => share.receipt_path),
      ].filter((path): path is string => Boolean(path)),
    ),
  );
  if (attachmentPaths.length) {
    await createServiceClient().storage
      .from(RECEIPT_BUCKET)
      .remove(attachmentPaths);
  }
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function setReimbursementStatus(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { supabase } = await requirePermission("mark_expenses_paid");
  const shareId = String(formData.get("share_id"));
  const status = String(formData.get("status"));
  if (!["paid", "pending"].includes(status)) {
    throw new Error("Status de reembolso inválido.");
  }
  const { error } = await supabase.rpc("set_expense_share_reimbursement", {
    target_share_id: shareId,
    target_status: status,
  });
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

// ----------------------------------------------------------------------
// Comprovantes de pagamento (por morador) e boleto (por despesa)
// ----------------------------------------------------------------------

export type ExpenseAttachmentTarget = {
  kind: "share_receipt" | "expense_boleto" | "expense_payment_receipt";
  id: string;
};

type ResolvedExpenseAttachment = {
  profile: Awaited<ReturnType<typeof requireActiveProfile>>["profile"];
  supabase: Awaited<ReturnType<typeof requireActiveProfile>>["supabase"];
  folder: string;
  previousPath: string | null;
  sharePaymentStatus?: string;
};

type UploadActionResult =
  | { ok: true; path?: string; token?: string; message: string }
  | { ok: false; message: string };

function uploadError(error: unknown, fallback: string): UploadActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : fallback,
  };
}

async function resolveExpenseAttachment(
  target: ExpenseAttachmentTarget,
): Promise<ResolvedExpenseAttachment> {
  const { profile, supabase } = await requireActiveProfile();

  if (target.kind === "share_receipt") {
    const { data: share } = await supabase
      .from("expense_shares")
      .select("id,member_id,receipt_path,payment_status,expense:expenses(household_id)")
      .eq("id", target.id)
      .single();
    const expense = Array.isArray(share?.expense)
      ? share.expense[0]
      : share?.expense;
    if (!share || !expense || expense.household_id !== profile.household_id) {
      throw new Error("Parcela não encontrada.");
    }
    const allowed =
      profile.member_id === share.member_id ||
      can(profile, "manage_expenses") ||
      can(profile, "mark_expenses_paid");
    if (!allowed) {
      throw new Error("Você não pode anexar comprovante para outro morador.");
    }
    return {
      profile,
      supabase,
      folder: `shares/${target.id}`,
      previousPath: share.receipt_path,
      sharePaymentStatus: share.payment_status,
    };
  }

  if (!can(profile, "manage_expenses")) {
    throw new Error("Você não tem permissão para anexar arquivos à despesa.");
  }
  const { data: expense } = await supabase
    .from("expenses")
    .select("id,household_id,boleto_path,payment_receipt_path")
    .eq("id", target.id)
    .single();
  if (!expense || expense.household_id !== profile.household_id) {
    throw new Error("Despesa não encontrada.");
  }
  return {
    profile,
    supabase,
    folder:
      target.kind === "expense_boleto"
        ? `expenses/${target.id}/boleto`
        : `expenses/${target.id}/comprovante-geral`,
    previousPath:
      target.kind === "expense_boleto"
        ? expense.boleto_path
        : expense.payment_receipt_path,
  };
}

export async function prepareExpenseAttachmentUpload(
  target: ExpenseAttachmentTarget,
  file: { name: string; type: string; size: number },
): Promise<UploadActionResult> {
  try {
    const validationError = validateReceiptMetadata(file);
    if (validationError) return { ok: false, message: validationError };
    const resolved = await resolveExpenseAttachment(target);
    if (resolved.sharePaymentStatus === "paid") {
      return {
        ok: false,
        message: "Desfaça a marcação de pagamento antes de substituir o comprovante.",
      };
    }
    const safeName = slugifyReceiptFileName(file.name || "arquivo") || "arquivo";
    const path = `${resolved.profile.household_id}/${resolved.folder}/${crypto.randomUUID()}-${safeName}`;
    const { data, error } = await createServiceClient().storage
      .from(RECEIPT_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data?.token) {
      return {
        ok: false,
        message: error?.message ?? "Não foi possível preparar o envio.",
      };
    }
    return {
      ok: true,
      path,
      token: data.token,
      message: "Envio autorizado.",
    };
  } catch (error) {
    return uploadError(error, "Não foi possível preparar o envio.");
  }
}

export async function finalizeExpenseAttachmentUpload(
  target: ExpenseAttachmentTarget,
  uploaded: { path: string; name: string },
): Promise<UploadActionResult> {
  try {
    const resolved = await resolveExpenseAttachment(target);
    const expectedPrefix = `${resolved.profile.household_id}/${resolved.folder}/`;
    if (!uploaded.path.startsWith(expectedPrefix)) {
      return { ok: false, message: "Caminho do arquivo inválido." };
    }

    const service = createServiceClient();
    if (resolved.sharePaymentStatus === "paid") {
      await service.storage.from(RECEIPT_BUCKET).remove([uploaded.path]);
      return {
        ok: false,
        message: "Desfaça a marcação de pagamento antes de substituir o comprovante.",
      };
    }
    const objectName = uploaded.path.slice(uploaded.path.lastIndexOf("/") + 1);
    const folder = uploaded.path.slice(0, uploaded.path.lastIndexOf("/"));
    const { data: objects, error: listError } = await service.storage
      .from(RECEIPT_BUCKET)
      .list(folder, { limit: 10, search: objectName });
    const storedObject = (objects ?? []).find((object) => object.name === objectName);
    if (listError || !storedObject) {
      return { ok: false, message: "O arquivo enviado não foi encontrado." };
    }
    const storedValidationError = validateStoredReceiptMetadata(
      storedObject.metadata as Record<string, unknown> | null,
    );
    if (storedValidationError) {
      await service.storage.from(RECEIPT_BUCKET).remove([uploaded.path]);
      return { ok: false, message: storedValidationError };
    }

    const now = new Date().toISOString();
    let saveError: { message: string } | null = null;
    if (target.kind === "share_receipt") {
      const updateQuery = service
        .from("expense_shares")
        .update({
          receipt_path: uploaded.path,
          receipt_name: uploaded.name,
          receipt_uploaded_by: resolved.profile.id,
          receipt_uploaded_at: now,
        })
        .eq("id", target.id)
        .neq("payment_status", "paid");
      const guardedQuery = resolved.previousPath
        ? updateQuery.eq("receipt_path", resolved.previousPath)
        : updateQuery.is("receipt_path", null);
      const { data: changed, error } = await guardedQuery
        .select("id")
        .maybeSingle();
      saveError =
        error ??
        (changed
          ? null
          : { message: "Desfaça a marcação de pagamento antes de substituir o comprovante." });
    } else {
      const values =
        target.kind === "expense_boleto"
          ? {
              boleto_path: uploaded.path,
              boleto_name: uploaded.name,
              boleto_uploaded_at: now,
            }
          : {
              payment_receipt_path: uploaded.path,
              payment_receipt_name: uploaded.name,
              payment_receipt_uploaded_by: resolved.profile.id,
              payment_receipt_uploaded_at: now,
            };
      const updateQuery = resolved.supabase
        .from("expenses")
        .update(values)
        .eq("id", target.id)
        .eq("household_id", resolved.profile.household_id);
      const guardedQuery = target.kind === "expense_boleto"
        ? resolved.previousPath
          ? updateQuery.eq("boleto_path", resolved.previousPath)
          : updateQuery.is("boleto_path", null)
        : resolved.previousPath
          ? updateQuery.eq("payment_receipt_path", resolved.previousPath)
          : updateQuery.is("payment_receipt_path", null);
      const { data: changed, error } = await guardedQuery
        .select("id")
        .maybeSingle();
      saveError =
        error ??
        (changed
          ? null
          : { message: "O anexo foi alterado em outra sessão. Tente novamente." });
    }

    if (saveError) {
      await service.storage.from(RECEIPT_BUCKET).remove([uploaded.path]);
      return { ok: false, message: saveError.message };
    }
    if (resolved.previousPath && resolved.previousPath !== uploaded.path) {
      await service.storage.from(RECEIPT_BUCKET).remove([resolved.previousPath]);
    }
    revalidatePath("/app/despesas");
    revalidatePath("/app/eu");
    return { ok: true, message: "Arquivo enviado com sucesso." };
  } catch (error) {
    return uploadError(error, "Não foi possível salvar o arquivo.");
  }
}

export async function deleteShareReceipt(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requireActiveProfile();
  const shareId = String(formData.get("share_id"));
  const { data: share } = await supabase
    .from("expense_shares")
    .select("member_id,receipt_path,payment_status,expense:expenses(household_id)")
    .eq("id", shareId)
    .single();
  const expense = Array.isArray(share?.expense)
    ? share.expense[0]
    : share?.expense;
  const allowed =
    share &&
    expense?.household_id === profile.household_id &&
    (profile.member_id === share.member_id ||
      can(profile, "manage_expenses") ||
      can(profile, "mark_expenses_paid"));
  if (!allowed) throw new Error("Você não pode remover este comprovante.");
  if (share?.payment_status === "paid") {
    throw new Error("Desfaça a marcação de pagamento antes de remover o comprovante.");
  }
  const service = createServiceClient();
  if (!share.receipt_path) throw new Error("Este comprovante já foi removido.");
  const { data: changed, error } = await service
    .from("expense_shares")
    .update({ receipt_path: null, receipt_name: null, receipt_uploaded_by: null, receipt_uploaded_at: null })
    .eq("id", shareId)
    .eq("receipt_path", share.receipt_path)
    .neq("payment_status", "paid")
    .select("id")
    .maybeSingle();
  if (error || !changed) {
    throw new Error(
      error?.message ?? "O pagamento ou o comprovante foi alterado em outra sessão.",
    );
  }
  await deleteFromReceiptBucket(service, share.receipt_path);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function deleteExpenseBoleto(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requirePermission("manage_expenses");
  const expenseId = String(formData.get("expense_id"));
  const { data: expense } = await supabase
    .from("expenses")
    .select("boleto_path")
    .eq("id", expenseId)
    .eq("household_id", profile.household_id)
    .single();
  if (!expense?.boleto_path) throw new Error("Este boleto já foi removido.");
  const { data: changed, error } = await supabase
    .from("expenses")
    .update({ boleto_path: null, boleto_name: null, boleto_uploaded_at: null })
    .eq("id", expenseId)
    .eq("household_id", profile.household_id)
    .eq("boleto_path", expense.boleto_path)
    .select("id")
    .maybeSingle();
  if (error || !changed) {
    throw new Error(error?.message ?? "O boleto foi alterado em outra sessão.");
  }
  await deleteFromReceiptBucket(createServiceClient(), expense.boleto_path);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function deleteExpensePaymentReceipt(formData: FormData) {
  const returnTo = destination(formData, "/app/despesas");
  const { profile, supabase } = await requirePermission("manage_expenses");
  const expenseId = String(formData.get("expense_id"));
  const { data: expense } = await supabase
    .from("expenses")
    .select("payment_receipt_path")
    .eq("id", expenseId)
    .eq("household_id", profile.household_id)
    .single();
  if (!expense?.payment_receipt_path) {
    throw new Error("Este comprovante geral já foi removido.");
  }
  const { data: changed, error } = await supabase
    .from("expenses")
    .update({
      payment_receipt_path: null,
      payment_receipt_name: null,
      payment_receipt_uploaded_by: null,
      payment_receipt_uploaded_at: null,
    })
    .eq("id", expenseId)
    .eq("household_id", profile.household_id)
    .eq("payment_receipt_path", expense.payment_receipt_path)
    .select("id")
    .maybeSingle();
  if (error || !changed) {
    throw new Error(
      error?.message ?? "O comprovante geral foi alterado em outra sessão.",
    );
  }
  await deleteFromReceiptBucket(
    createServiceClient(),
    expense.payment_receipt_path,
  );
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}
