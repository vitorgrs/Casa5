"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  requireActiveProfile,
  requireAdmin,
  requirePermission,
} from "@/lib/auth";
import type { FormActionState } from "@/lib/form-action-state";
import { deleteFromReceiptBucket, uploadToReceiptBucket } from "@/lib/storage";

function destination(formData: FormData, fallback: string) {
  const value = String(formData.get("redirect_to") ?? "");
  return value.startsWith("/app") ? value : fallback;
}

function pathOf(url: string) {
  return url.split("?")[0] || "/app";
}

function decimal(value: FormDataEntryValue | null): number | null {
  let text = String(value ?? "").trim().replace(/\s/g, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function deletePurchaseReceipts(
  supabase: Awaited<ReturnType<typeof requireActiveProfile>>["supabase"],
  purchaseId: string,
) {
  const { data: shares } = await supabase
    .from("shopping_purchase_shares")
    .select("receipt_path")
    .eq("purchase_id", purchaseId)
    .not("receipt_path", "is", null);

  const uniquePaths = Array.from(
    new Set((shares ?? []).map((share) => share.receipt_path).filter((path): path is string => Boolean(path))),
  );
  await Promise.all(uniquePaths.map(async (path) => {
    const { count } = await supabase
      .from("shopping_purchase_shares")
      .select("id", { count: "exact", head: true })
      .eq("receipt_path", path)
      .neq("purchase_id", purchaseId);
    if ((count ?? 0) === 0) await deleteFromReceiptBucket(supabase, path);
  }));
}

// ----------------------------------------------------------------------
// Tarefas (organização / calendário do Casa em dia)
// ----------------------------------------------------------------------

export async function createTask(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requirePermission("manage_tasks");
  const scope = String(formData.get("scope") ?? "geral") === "casa" ? "casa" : "geral";
  const title = String(formData.get("title") ?? "").trim();
  if (!title) throw new Error("Informe um título para a tarefa.");
  const description = String(formData.get("description") ?? "").trim() || null;
  const dueDate = String(formData.get("due_date") ?? "") || null;
  const memberIds = formData.getAll("member_ids").map(String).filter(Boolean);

  const { data: task, error } = await supabase
    .from("tasks")
    .insert({
      household_id: profile.household_id,
      scope,
      title,
      description,
      due_date: dueDate,
      source: "manual",
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error || !task) throw new Error(error?.message ?? "Não foi possível criar a tarefa.");

  if (memberIds.length) {
    const { error: assigneeError } = await supabase.from("task_assignees").insert(
      memberIds.map((memberId) => ({
        task_id: task.id,
        member_id: memberId,
        // tarefas do calendário registram quem já fez; tarefas gerais nascem pendentes
        done: scope === "casa",
        done_at: scope === "casa" ? new Date().toISOString() : null,
      })),
    );
    if (assigneeError) throw new Error(assigneeError.message);
  }

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function toggleTaskAssignee(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  // Qualquer morador ativo pode tentar marcar uma tarefa como concluída; a
  // política de RLS garante que só é possível alterar a própria atribuição,
  // a não ser que o perfil tenha a permissão manage_tasks.
  const { supabase } = await requireActiveProfile();
  const assigneeId = String(formData.get("assignee_id"));
  const done = String(formData.get("done")) === "1";

  const { error } = await supabase
    .from("task_assignees")
    .update({ done, done_at: done ? new Date().toISOString() : null })
    .eq("id", assigneeId);
  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function deleteTask(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requirePermission("manage_tasks");
  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", String(formData.get("task_id")))
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

// ----------------------------------------------------------------------
// Lista de compras
// ----------------------------------------------------------------------

export async function addShoppingItem(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Informe o nome do item.");
  const quantityPlanned = decimal(formData.get("quantity_planned"));
  if (quantityPlanned !== null && quantityPlanned <= 0) {
    throw new Error("A quantidade planejada precisa ser maior que zero.");
  }
  const { error } = await supabase.from("shopping_items").insert({
    household_id: profile.household_id,
    name,
    note: String(formData.get("note") ?? "").trim() || null,
    category: String(formData.get("category") ?? "").trim() || null,
    quantity_planned: quantityPlanned,
    added_by: profile.id,
  });
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function toggleShoppingChecked(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requireAdmin();
  const itemId = String(formData.get("item_id"));
  const nextStatus = String(formData.get("next_status") ?? "checked");
  if (!["list", "checked"].includes(nextStatus)) throw new Error("Status do item inválido.");
  const patch: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "checked") patch.checked_at = new Date().toISOString();
  if (nextStatus === "list") {
    patch.checked_at = null;
  }
  const { error } = await supabase
    .from("shopping_items")
    .update(patch)
    .eq("id", itemId)
    .in("status", ["list", "checked"]);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function updateShoppingItem(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requireAdmin();
  const itemId = String(formData.get("item_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const quantityPlanned = decimal(formData.get("quantity_planned"));
  if (!name) throw new Error("Informe o nome do item.");
  if (quantityPlanned !== null && quantityPlanned <= 0) {
    throw new Error("A quantidade planejada precisa ser maior que zero.");
  }

  const { error } = await supabase
    .from("shopping_items")
    .update({ name, quantity_planned: quantityPlanned })
    .eq("id", itemId)
    .eq("household_id", profile.household_id)
    .in("status", ["list", "checked"]);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function recordShoppingPurchase(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requireAdmin();
  const itemIds = Array.from(
    new Set(formData.getAll("selected_item_ids").map(String).filter(Boolean)),
  );
  const scope = String(formData.get("purchase_scope") ?? "");
  const payerMemberId = String(formData.get("paid_by_member_id") ?? "");
  const participantIds = Array.from(
    new Set(formData.getAll("participant_ids").map(String).filter(Boolean)),
  );
  const quantities = itemIds.map((itemId) => decimal(formData.get(`quantity_${itemId}`)));
  const unitPrices = itemIds.map((itemId) => decimal(formData.get(`unit_price_${itemId}`)));

  if (itemIds.length === 0) throw new Error("Selecione pelo menos um item.");
  if (quantities.some((value) => value === null || value <= 0)) {
    throw new Error("Informe uma quantidade válida para todos os itens.");
  }
  if (unitPrices.some((value) => value === null || value < 0)) {
    throw new Error("Informe o valor unitário de todos os itens.");
  }
  if (!payerMemberId) throw new Error("Selecione quem pagou a compra.");

  const { error } = await supabase.rpc("record_multi_item_shopping_purchase", {
    target_item_ids: itemIds,
    purchased_quantities: quantities as number[],
    purchased_unit_prices: unitPrices as number[],
    selected_scope: scope,
    payer_member_id: payerMemberId,
    participant_member_ids: participantIds,
  });
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  revalidatePath("/app/eu");
  redirect(returnTo);
}

export async function resetShoppingPurchase(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requireAdmin();
  const purchaseId = String(formData.get("purchase_id") ?? "");
  const { count: pendingReceipts } = await supabase
    .from("shopping_purchase_shares")
    .select("id", { count: "exact", head: true })
    .eq("purchase_id", purchaseId)
    .eq("payment_status", "pending")
    .not("receipt_path", "is", null);
  if ((pendingReceipts ?? 0) > 0) {
    throw new Error("Confirme o comprovante pendente antes de desfazer esta compra.");
  }
  await deletePurchaseReceipts(supabase, purchaseId);
  const { error } = await supabase.rpc("reset_shopping_purchase", {
    target_purchase_id: purchaseId,
  });
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  revalidatePath("/app/eu");
  redirect(returnTo);
}

export async function removeItemFromShoppingPurchase(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requireAdmin();
  const purchaseId = String(formData.get("purchase_id") ?? "");
  const itemId = String(formData.get("item_id") ?? "");
  if (!purchaseId || !itemId) throw new Error("Compra ou item não informado.");

  const { error } = await supabase.rpc("remove_item_from_shopping_purchase", {
    target_purchase_id: purchaseId,
    target_item_id: itemId,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent("Item retirado e rateio recalculado.")}`);
}

export async function deleteShoppingItem(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requireAdmin();
  const itemId = String(formData.get("item_id"));
  const { error } = await supabase
    .from("shopping_items")
    .delete()
    .eq("id", itemId)
    .eq("household_id", profile.household_id)
    .in("status", ["list", "checked"]);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  revalidatePath("/app/eu");
  redirect(returnTo);
}

export async function uploadShoppingNetReceipt(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requireActiveProfile();
  const shareId = String(formData.get("share_id") ?? "");
  const paidAmount = decimal(formData.get("payment_amount"));
  const file = formData.get("file");
  if (paidAmount === null || paidAmount <= 0) {
    return { status: "error", message: "Informe o valor que foi pago." };
  }
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: "error",
      message: "Selecione um arquivo (PDF ou foto) antes de enviar.",
    };
  }

  const { data: share, error: shareError } = await supabase
    .from("shopping_purchase_shares")
    .select("id,member_id,receipt_path,purchase:shopping_purchases(household_id)")
    .eq("id", shareId)
    .single();
  const purchase = Array.isArray(share?.purchase) ? share.purchase[0] : share?.purchase;
  if (shareError || !share || !purchase || purchase.household_id !== profile.household_id) {
    return { status: "error", message: "Dívida de compra não encontrada." };
  }
  if (share.member_id !== profile.member_id && profile.role !== "admin") {
    return {
      status: "error",
      message: "Somente o devedor ou o administrador pode enviar este comprovante.",
    };
  }
  if (share.receipt_path) {
    return {
      status: "error",
      message: "Esta dívida já possui um comprovante enviado.",
    };
  }

  let uploaded: Awaited<ReturnType<typeof uploadToReceiptBucket>>;
  try {
    uploaded = await uploadToReceiptBucket(
      supabase,
      profile.household_id!,
      `shopping-net/${shareId}`,
      file,
    );
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível enviar o arquivo.",
    };
  }

  const { error } = await supabase.rpc("submit_shopping_net_receipt", {
    target_share_id: shareId,
    uploaded_path: uploaded.path,
    uploaded_name: uploaded.name,
    paid_amount: paidAmount,
  });
  if (error) {
    await deleteFromReceiptBucket(supabase, uploaded.path);
    return { status: "error", message: error.message };
  }

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  revalidatePath(pathOf(returnTo));
  return {
    status: "success",
    message: `Comprovante de ${paidAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} enviado. O valor aguarda confirmação.`,
  };
}

export async function confirmShoppingNetPayment(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/eu");
  const { supabase } = await requireActiveProfile();
  const paymentId = String(formData.get("payment_id") ?? "");
  if (!paymentId) {
    return { status: "error", message: "Pagamento não informado." };
  }
  const { error } = await supabase.rpc("confirm_shopping_net_payment", {
    target_payment_id: paymentId,
  });
  if (error) return { status: "error", message: error.message };

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  revalidatePath(pathOf(returnTo));
  return {
    status: "success",
    message: "Pagamento confirmado. Se houver saldo restante, ele continua em aberto.",
  };
}

export async function settleZeroShoppingBalance(formData: FormData) {
  const returnTo = destination(formData, "/app/eu");
  const { supabase } = await requireActiveProfile();
  const counterpartyMemberId = String(formData.get("counterparty_member_id") ?? "");
  const { error } = await supabase.rpc("settle_zero_shopping_balance", {
    counterparty_member_id: counterpartyMemberId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent("Dívidas compensadas e quitadas.")}`);
}

export async function settleZeroShoppingBalanceAsAdmin(formData: FormData) {
  const returnTo = destination(formData, "/app/eu");
  const { supabase } = await requireAdmin();
  const firstMemberId = String(formData.get("first_member_id") ?? "");
  const secondMemberId = String(formData.get("second_member_id") ?? "");
  if (!firstMemberId || !secondMemberId || firstMemberId === secondMemberId) {
    throw new Error("Informe dois moradores diferentes para a compensação.");
  }

  const { error } = await supabase.rpc("settle_zero_shopping_balance_as_admin", {
    first_member_id: firstMemberId,
    second_member_id: secondMemberId,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  redirect(
    `${pathOf(returnTo)}?success=${encodeURIComponent("Acerto compensado pelo administrador.")}`,
  );
}
