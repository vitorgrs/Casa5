"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

const BASE_ROUTE = "/app/financeiro";

// Preserva os filtros da tela ao voltar da ação.
function back(formData: FormData, kind: "success" | "error", message: string): never {
  const query = String(formData.get("return_query") ?? "");
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  params.delete("success");
  params.delete("error");
  params.set(kind, message);
  redirect(`${BASE_ROUTE}?${params.toString()}`);
}

function refresh() {
  revalidatePath(BASE_ROUTE);
  revalidatePath("/app/despesas");
  revalidatePath("/app/eu");
  revalidatePath("/app");
}

export async function reconcileMovement(formData: FormData) {
  const { supabase } = await requirePermission("manage_wallet");
  const movementId = String(formData.get("movement_id") ?? "");
  const shareIds = formData.getAll("share_ids").map(String).filter(Boolean);
  if (!movementId || shareIds.length === 0) {
    back(formData, "error", "Selecione ao menos uma parcela para conciliar.");
  }

  const { data, error } = await supabase.rpc("reconcile_wallet_movement", {
    target_movement_id: movementId,
    target_share_ids: shareIds,
  });
  if (error) back(formData, "error", error.message);
  refresh();
  back(formData, "success", `${data ?? shareIds.length} parcela(s) marcada(s) como paga(s) pelo Pix.`);
}

export async function undoReconciliation(formData: FormData) {
  const { supabase } = await requirePermission("manage_wallet");
  const movementId = String(formData.get("movement_id") ?? "");
  const { data, error } = await supabase.rpc("undo_wallet_reconciliation", {
    target_movement_id: movementId,
  });
  if (error) back(formData, "error", error.message);
  refresh();
  back(formData, "success", `Conciliação desfeita: ${data ?? 0} parcela(s) voltaram a ficar em aberto.`);
}

export async function setMovementIgnored(formData: FormData) {
  const { profile, supabase } = await requirePermission("manage_wallet");
  const movementId = String(formData.get("movement_id") ?? "");
  const ignored = formData.get("ignored") === "true";
  const { data, error } = await supabase
    .from("wallet_movements")
    .update({ ignored })
    .eq("id", movementId)
    .eq("household_id", profile.household_id)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    back(formData, "error", error?.message ?? "Movimentação não encontrada.");
  }
  revalidatePath(BASE_ROUTE);
  back(
    formData,
    "success",
    ignored
      ? "Entrada marcada como não relacionada às despesas."
      : "Entrada voltou para a lista de conciliação.",
  );
}
