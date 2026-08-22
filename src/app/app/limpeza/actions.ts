"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveProfile, requireAdmin } from "@/lib/auth";
import { isIsoDate, STANDARD_DAILY_TASKS } from "@/lib/chore-rotation";

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
  if (!STANDARD_DAILY_TASKS.some((task) => task.key === taskKey)) {
    throw new Error("Tarefa padrão inválida.");
  }

  const { error } = await supabase.rpc("toggle_daily_chore_completion", {
    target_date: date,
    target_task_key: taskKey,
    mark_completed: completed,
  });
  if (error) throw new Error(error.message);

  refreshRotationPages();
  redirect(withRefresh(returnTo));
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
