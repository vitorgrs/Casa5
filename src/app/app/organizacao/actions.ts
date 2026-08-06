"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveProfile, requirePermission } from "@/lib/auth";

function destination(formData: FormData, fallback: string) {
  const value = String(formData.get("redirect_to") ?? "");
  return value.startsWith("/app") ? value : fallback;
}

function pathOf(url: string) {
  return url.split("?")[0] || "/app";
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
  const quantity = Number(String(formData.get("quantity_bought") ?? "0").replace(",", "."));
  const unitPrice = Number(String(formData.get("unit_price") ?? "0").replace(",", "."));
  const { error } = await supabase
    .from("shopping_items")
    .update({
      status: "bought",
      quantity_bought: Number.isFinite(quantity) ? quantity : null,
      unit_price: Number.isFinite(unitPrice) ? unitPrice : null,
      bought_at: new Date().toISOString(),
    })
    .eq("id", itemId);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function resetShoppingItem(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requirePermission("manage_shopping");
  const itemId = String(formData.get("item_id"));
  const { error } = await supabase
    .from("shopping_items")
    .update({ status: "list", checked_at: null, bought_at: null })
    .eq("id", itemId);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function deleteShoppingItem(formData: FormData) {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requirePermission("manage_shopping");
  const { error } = await supabase
    .from("shopping_items")
    .delete()
    .eq("id", String(formData.get("item_id")))
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}
