"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveProfile, requirePermission } from "@/lib/auth";
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

async function deleteShoppingReceipts(
  supabase: Awaited<ReturnType<typeof requireActiveProfile>>["supabase"],
  itemId: string,
) {
  const { data: shares } = await supabase
    .from("shopping_item_shares")
    .select("receipt_path")
    .eq("shopping_item_id", itemId)
    .not("receipt_path", "is", null);

  await Promise.all(
    (shares ?? [])
      .map((share) => share.receipt_path)
      .filter((path): path is string => Boolean(path))
      .map((path) => deleteFromReceiptBucket(supabase, path)),
  );
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
  const { profile, supabase } = await requirePermission("manage_shopping");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Informe o nome do item.");
  const { error } = await supabase.from("shopping_items").insert({
    household_id: profile.household_id,
    name,
    note: String(formData.get("note") ?? "").trim() || null,
    category: String(formData.get("category") ?? "").trim() || null,
    quantity_planned: formData.get("quantity_planned")
      ? Number(String(formData.get("quantity_planned")).replace(",", "."))
      : null,
    added_by: profile.id,
  });
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function toggleShoppingChecked(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requirePermission("manage_shopping");
  const itemId = String(formData.get("item_id"));
  const nextStatus = String(formData.get("next_status") ?? "checked");
  const patch: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "checked") patch.checked_at = new Date().toISOString();
  if (nextStatus === "list") {
    patch.checked_at = null;
  }
  const { error } = await supabase.from("shopping_items").update(patch).eq("id", itemId);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function recordShoppingPurchase(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requirePermission("manage_shopping");
  const itemId = String(formData.get("item_id"));
  const quantity = decimal(formData.get("quantity_bought"));
  const unitPrice = decimal(formData.get("unit_price"));
  const scope = String(formData.get("purchase_scope") ?? "");
  const payerMemberId = String(formData.get("paid_by_member_id") ?? "");
  const participantIds = Array.from(
    new Set(formData.getAll("participant_ids").map(String).filter(Boolean)),
  );

  if (quantity === null || quantity <= 0) throw new Error("Informe uma quantidade válida.");
  if (unitPrice === null || unitPrice < 0) throw new Error("Informe um valor unitário válido.");
  if (!payerMemberId) throw new Error("Selecione quem pagou a compra.");

  const { error } = await supabase.rpc("record_shopping_purchase", {
    target_item_id: itemId,
    purchased_quantity: quantity,
    purchased_unit_price: unitPrice,
    selected_scope: scope,
    payer_member_id: payerMemberId,
    participant_member_ids: participantIds,
  });
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  revalidatePath("/app/eu");
  redirect(returnTo);
}

export async function resetShoppingItem(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requirePermission("manage_shopping");
  const itemId = String(formData.get("item_id"));
  await deleteShoppingReceipts(supabase, itemId);
  const { error: sharesError } = await supabase
    .from("shopping_item_shares")
    .delete()
    .eq("shopping_item_id", itemId);
  if (sharesError) throw new Error(sharesError.message);
  const { error } = await supabase
    .from("shopping_items")
    .update({
      status: "list",
      checked_at: null,
      bought_at: null,
      quantity_bought: null,
      unit_price: null,
      purchase_scope: null,
      paid_by_member_id: null,
    })
    .eq("id", itemId);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  revalidatePath("/app/eu");
  redirect(returnTo);
}

export async function deleteShoppingItem(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requirePermission("manage_shopping");
  const itemId = String(formData.get("item_id"));
  await deleteShoppingReceipts(supabase, itemId);
  const { error } = await supabase
    .from("shopping_items")
    .delete()
    .eq("id", itemId)
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  revalidatePath("/app/eu");
  redirect(returnTo);
}

export async function uploadShoppingShareReceipt(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requireActiveProfile();
  const shareId = String(formData.get("share_id") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Selecione um arquivo (PDF ou foto) antes de enviar.");
  }

  const { data: share } = await supabase
    .from("shopping_item_shares")
    .select("id,member_id,receipt_path,item:shopping_items(household_id)")
    .eq("id", shareId)
    .single();
  const item = Array.isArray(share?.item) ? share.item[0] : share?.item;
  if (!share || !item || item.household_id !== profile.household_id) {
    throw new Error("Dívida de compra não encontrada.");
  }
  if (share.member_id !== profile.member_id) {
    throw new Error("Você só pode enviar o comprovante da sua própria dívida.");
  }
  if (share.receipt_path) {
    throw new Error("Esta dívida já possui um comprovante enviado.");
  }

  const uploaded = await uploadToReceiptBucket(
    supabase,
    profile.household_id!,
    `shopping-shares/${shareId}`,
    file,
  );

  const { error } = await supabase.rpc("submit_shopping_share_receipt", {
    target_share_id: shareId,
    uploaded_path: uploaded.path,
    uploaded_name: uploaded.name,
  });
  if (error) {
    await deleteFromReceiptBucket(supabase, uploaded.path);
    throw new Error(error.message);
  }

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent("Comprovante da compra enviado.")}`);
}

export async function confirmShoppingSharePayment(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requireActiveProfile();
  const shareId = String(formData.get("share_id") ?? "");
  const { error } = await supabase.rpc("confirm_shopping_share_payment", {
    target_share_id: shareId,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  redirect(returnTo);
}
