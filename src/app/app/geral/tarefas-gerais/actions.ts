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

export async function createGeneralTask(formData: FormData) {
  const returnTo = destination(formData, "/app/geral/tarefas");
  const { profile, supabase } = await requireAdmin();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) throw new Error("Título é obrigatório.");

  const status = "pending"; // começa como pendente

  const { data: task, error } = await supabase
    .from("tasks_tasks")
    .insert({
      household_id: profile.household_id,
      title,
      description: String(formData.get("description") ?? "") || null,
      due_date: String(formData.get("due_date") ?? "") || null,
      assigned_to: formData.getAll("assigned_to").map(String),
      priority: String(formData.get("priority") ?? "normal"),
      status,
      created_by: profile.id,
      expense_refund_id: String(formData.get("expense_refund_id") ?? "") || null,
      updated_by: profile.id,
    })
    .select("id")
    .single();

  if (error || !task) throw new Error(error?.message ?? "Não foi possível criar a tarefa.");

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function updateGeneralTask(formData: FormData) {
  const returnTo = destination(formData, "/app/geral/tarefas");
  const { profile, supabase } = await requireAdmin();
  const taskId = String(formData.get("task_id"));

  const updates: any = {
    title: String(formData.get("title") ?? "").trim(),
    description: String(formData.get("description") ?? "") || null,
    due_date: String(formData.get("due_date") ?? "") || null,
    assigned_to: formData.getAll("assigned_to").map(String),
    priority: String(formData.get("priority") ?? "normal"),
    status: String(formData.get("status") ?? "pending"),
    expense_refund_id: String(formData.get("expense_refund_id") ?? "") || null,
    updated_by: profile.id,
    completed_at: formData.get("status") === "completed" ? new Date().toISOString() : null,
    completed_by: formData.get("status") === "completed" ? profile.id : null,
  };

  const { error } = await supabase
    .from("tasks_tasks")
    .update(updates)
    .eq("id", taskId)
    .eq("household_id", profile.household_id);

  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function deleteGeneralTask(formData: FormData) {
  const returnTo = destination(formData, "/app/geral/tarefas");
  const { profile, supabase } = await requireAdmin();
  const taskId = String(formData.get("task_id"));

  const { error } = await supabase
    .from("tasks_tasks")
    .delete()
    .eq("id", taskId)
    .eq("household_id", profile.household_id);

  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function completeGeneralTask(formData: FormData) {
  const returnTo = destination(formData, "/app/geral/tarefas");
  const { profile, supabase } = await requireAdmin();
  const taskId = String(formData.get("task_id"));

  const { error } = await supabase
    .from("tasks_tasks")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: profile.id,
      updated_by: profile.id,
    })
    .eq("id", taskId)
    .eq("household_id", profile.household_id);

  if (error) throw new Error(error.message);

  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}
