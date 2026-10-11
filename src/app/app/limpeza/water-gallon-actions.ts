"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { isIsoDate, todayIso } from "@/lib/chore-rotation";
import type { FormActionState } from "@/lib/form-action-state";

function refreshWaterGallonPages() {
  revalidatePath("/app/limpeza");
  revalidatePath("/app/limpeza/agua");
  revalidatePath("/app");
}

function actionError(error: unknown, fallback: string): FormActionState {
  unstable_rethrow(error);
  return {
    status: "error",
    message: error instanceof Error ? error.message : fallback,
  };
}

export async function saveWaterGallonRotation(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  try {
    const { supabase } = await requireAdmin();
    const memberIds = formData.getAll("member_ids").map(String).filter(Boolean);
    if (memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) {
      return {
        status: "error",
        message: "A ordem precisa conter cada morador uma única vez.",
      };
    }

    const { error } = await supabase.rpc("set_water_gallon_rotation", {
      ordered_member_ids: memberIds,
      target_current_member_id: null,
    });
    if (error) return { status: "error", message: error.message };

    refreshWaterGallonPages();
    return { status: "success", message: "Ordem do galão atualizada." };
  } catch (error) {
    return actionError(error, "Não foi possível atualizar a ordem do galão.");
  }
}

export async function changeWaterGallonTurn(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  try {
    const { supabase } = await requireAdmin();
    const memberId = String(formData.get("member_id") ?? "");
    const note = String(formData.get("note") ?? "").trim();
    if (!memberId) {
      return { status: "error", message: "Selecione a pessoa da vez." };
    }
    if (note.length > 300) {
      return { status: "error", message: "O motivo deve ter no máximo 300 caracteres." };
    }

    const { error } = await supabase.rpc("set_water_gallon_current_member", {
      target_member_id: memberId,
      change_note: note || null,
    });
    if (error) return { status: "error", message: error.message };

    refreshWaterGallonPages();
    return { status: "success", message: "Pessoa da vez alterada." };
  } catch (error) {
    return actionError(error, "Não foi possível alterar a pessoa da vez.");
  }
}

export async function recordWaterGallonManualPayment(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  try {
    const { supabase } = await requireAdmin();
    const paymentDate = String(formData.get("paid_on") ?? "");
    const expectedMemberId = String(formData.get("expected_member_id") ?? "");
    const note = String(formData.get("note") ?? "").trim();
    if (!isIsoDate(paymentDate) || paymentDate > todayIso()) {
      return { status: "error", message: "Informe uma data de pagamento válida." };
    }
    if (!expectedMemberId) {
      return { status: "error", message: "Atualize a página e tente novamente." };
    }
    if (note.length > 300) {
      return { status: "error", message: "A observação deve ter no máximo 300 caracteres." };
    }

    const { error } = await supabase.rpc("record_water_gallon_payment", {
      payment_date: paymentDate,
      payment_note: note || null,
      expected_member_id: expectedMemberId,
    });
    if (error) return { status: "error", message: error.message };

    refreshWaterGallonPages();
    return {
      status: "success",
      message: "Pagamento confirmado. O rodízio avançou para a próxima pessoa.",
    };
  } catch (error) {
    return actionError(error, "Não foi possível registrar o pagamento do galão.");
  }
}

export async function reviewWaterGallonPurchase(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  try {
    const { supabase } = await requireAdmin();
    const purchaseId = String(formData.get("purchase_id") ?? "");
    const decision = String(formData.get("decision") ?? "");
    if (!purchaseId || !["confirm", "reject"].includes(decision)) {
      return { status: "error", message: "Compra ou decisão inválida." };
    }

    const { error } = await supabase.rpc("review_water_gallon_purchase", {
      target_purchase_id: purchaseId,
      review_decision: decision,
    });
    if (error) return { status: "error", message: error.message };

    refreshWaterGallonPages();
    return decision === "confirm"
      ? {
          status: "success",
          message: "Pagamento confirmado. Agora é a vez da próxima pessoa.",
        }
      : {
          status: "success",
          message: "Sugestão recusada. A pessoa da vez não foi alterada.",
        };
  } catch (error) {
    return actionError(error, "Não foi possível revisar a compra sugerida.");
  }
}
