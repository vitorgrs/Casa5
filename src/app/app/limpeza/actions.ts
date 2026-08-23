"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveProfile, requireAdmin } from "@/lib/auth";
import { isIsoDate } from "@/lib/chore-rotation";

function destination(formData: FormData, fallback: string) {
  const value = String(formData.get("redirect_to") ?? "");
  return value.startsWith("/app") ? value : fallback;
}

function withMessage(url: string, kind: "success" | "error", message: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${kind}=${encodeURIComponent(message)}&updated=${Date.now()}`;
}

function withRefresh(url: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}updated=${Date.now()}`;
}

function refreshRotationPages() {
  revalidatePath("/app/limpeza");
  revalidatePath("/app/limpeza/rotina");
  revalidatePath("/app");
  revalidatePath("/app/eu");
}

export async function saveDailyRotation(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza/rotina");
  const { supabase } = await requireAdmin();
  const startDate = String(formData.get("start_date") ?? "");
  const memberIds = formData.getAll("member_ids").map(String).filter(Boolean);

  if (!isIsoDate(startDate)) throw new Error("Informe uma data de início válida.");
  if (memberIds.length === 0) throw new Error("A escala precisa ter moradores.");

  const { error } = await supabase.rpc("set_daily_rotation", {
    rotation_start_date: startDate,
    ordered_member_ids: memberIds,
  });
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(withMessage(returnTo, "success", "Ordem da escala atualizada."));
}

export async function requestDaySwap(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza");
  const { supabase } = await requireActiveProfile();
  const requesterDate = String(formData.get("requester_date") ?? "");
  const targetDate = String(formData.get("target_date") ?? "");

  if (!isIsoDate(requesterDate) || !isIsoDate(targetDate)) {
    throw new Error("Selecione duas datas válidas para a troca.");
  }

  const { error } = await supabase.rpc("request_chore_day_swap", {
    target_requester_date: requesterDate,
    target_target_date: targetDate,
  });
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(withMessage(returnTo, "success", "Troca enviada para aprovação do administrador."));
}

export async function reviewDaySwap(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza/rotina");
  const { supabase } = await requireAdmin();
  const requestId = String(formData.get("request_id") ?? "");
  const decision = String(formData.get("decision") ?? "reject");

  if (!requestId) throw new Error("Solicitação não informada.");
  const approved = decision === "approve";
  const { error } = await supabase.rpc("review_chore_day_swap", {
    target_request_id: requestId,
    approve_request: approved,
  });
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(
    withMessage(
      returnTo,
      "success",
      approved ? "Troca aprovada e aplicada ao calendário." : "Troca recusada.",
    ),
  );
}

export async function toggleDailyTaskCompletion(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza");
  const { supabase } = await requireActiveProfile();
  const date = String(formData.get("reference_date") ?? "");
  const taskKey = String(formData.get("task_key") ?? "");
  const completed = String(formData.get("completed") ?? "0") === "1";

  if (!isIsoDate(date)) throw new Error("Data inválida.");
  if (!taskKey) throw new Error("Tarefa padrão inválida.");

  const { error } = await supabase.rpc("toggle_daily_chore_completion", {
    target_date: date,
    target_task_key: taskKey,
    mark_completed: completed,
  });
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(withRefresh(returnTo));
}

export async function createStandardDailyTask(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza/rotina");
  const { profile, supabase } = await requireAdmin();
  const label = String(formData.get("label") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!label) throw new Error("Informe o nome da tarefa padrão.");
  if (label.length > 120) throw new Error("O nome deve ter no máximo 120 caracteres.");
  if (description.length > 500) {
    throw new Error("A descrição deve ter no máximo 500 caracteres.");
  }

  const { data: lastTask, error: orderError } = await supabase
    .from("daily_standard_tasks")
    .select("display_order")
    .eq("household_id", profile.household_id)
    .order("display_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (orderError) throw new Error(orderError.message);

  const taskKey = `custom_${crypto.randomUUID()}`;
  const { error } = await supabase.from("daily_standard_tasks").insert({
    household_id: profile.household_id,
    task_key: taskKey,
    label,
    description: description || null,
    display_order: (lastTask?.display_order ?? 0) + 1,
    active: true,
    created_by: profile.id,
    updated_by: profile.id,
  });
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(withMessage(returnTo, "success", "Tarefa padrão adicionada."));
}

export async function updateStandardDailyTask(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza/rotina");
  const { profile, supabase } = await requireAdmin();
  const taskKey = String(formData.get("task_key") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!taskKey || !label) throw new Error("Informe a tarefa e o nome.");
  if (label.length > 120) throw new Error("O nome deve ter no máximo 120 caracteres.");
  if (description.length > 500) {
    throw new Error("A descrição deve ter no máximo 500 caracteres.");
  }

  const { error } = await supabase
    .from("daily_standard_tasks")
    .update({
      label,
      description: description || null,
      updated_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq("household_id", profile.household_id)
    .eq("task_key", taskKey);
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(withMessage(returnTo, "success", "Tarefa padrão atualizada."));
}

export async function setStandardDailyTaskActive(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza/rotina");
  const { profile, supabase } = await requireAdmin();
  const taskKey = String(formData.get("task_key") ?? "");
  const active = String(formData.get("active") ?? "0") === "1";

  if (!taskKey) throw new Error("Tarefa padrão não informada.");

  const { error } = await supabase
    .from("daily_standard_tasks")
    .update({
      active,
      updated_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq("household_id", profile.household_id)
    .eq("task_key", taskKey);
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(
    withMessage(
      returnTo,
      "success",
      active ? "Tarefa padrão reativada." : "Tarefa padrão desativada.",
    ),
  );
}

export async function moveStandardDailyTask(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza/rotina");
  const { profile, supabase } = await requireAdmin();
  const taskKey = String(formData.get("task_key") ?? "");
  const direction = String(formData.get("direction") ?? "") === "up" ? -1 : 1;

  if (!taskKey) throw new Error("Tarefa padrão não informada.");

  const { data: tasks, error: fetchError } = await supabase
    .from("daily_standard_tasks")
    .select("task_key,display_order")
    .eq("household_id", profile.household_id)
    .eq("active", true)
    .order("display_order")
    .order("created_at");
  if (fetchError) throw new Error(fetchError.message);

  const currentIndex = (tasks ?? []).findIndex((task) => task.task_key === taskKey);
  const targetIndex = currentIndex + direction;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= (tasks?.length ?? 0)) {
    redirect(returnTo);
  }

  const current = tasks![currentIndex];
  const target = tasks![targetIndex];
  const now = new Date().toISOString();
  const [{ error: currentError }, { error: targetError }] = await Promise.all([
    supabase
      .from("daily_standard_tasks")
      .update({ display_order: target.display_order, updated_by: profile.id, updated_at: now })
      .eq("household_id", profile.household_id)
      .eq("task_key", current.task_key),
    supabase
      .from("daily_standard_tasks")
      .update({ display_order: current.display_order, updated_by: profile.id, updated_at: now })
      .eq("household_id", profile.household_id)
      .eq("task_key", target.task_key),
  ]);
  if (currentError) throw new Error(currentError.message);
  if (targetError) throw new Error(targetError.message);

  refreshRotationPages();
  redirect(withMessage(returnTo, "success", "Ordem das tarefas atualizada."));
}

export async function recordDailyExtraTask(formData: FormData) {
  const returnTo = destination(formData, "/app/limpeza");
  const { supabase } = await requireActiveProfile();
  const date = String(formData.get("reference_date") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!isIsoDate(date)) throw new Error("Data inválida.");
  if (!title) throw new Error("Informe a tarefa realizada.");

  const { error } = await supabase.rpc("record_daily_extra_task", {
    target_date: date,
    task_title: title,
    task_description: description || null,
  });
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(withMessage(returnTo, "success", "Tarefa extra registrada."));
}
