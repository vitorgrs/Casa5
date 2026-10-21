"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireActiveProfile, requirePermission } from "@/lib/auth";
import type { FormActionState } from "@/lib/form-action-state";

const DISH_RACK_ACTION_TIMEOUT_MS = 15_000;

function refreshDishRackCleaningPages() {
  revalidatePath("/app/limpeza/louca");
  revalidatePath("/app/limpeza");
  revalidatePath("/app");
}

function actionError(error: unknown, fallback: string): FormActionState {
  unstable_rethrow(error);
  return {
    status: "error",
    message: error instanceof Error ? error.message : fallback,
  };
}

export async function changeDishRackCleaningTurn(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const signal = AbortSignal.timeout(DISH_RACK_ACTION_TIMEOUT_MS);
  try {
    const { supabase } = await requirePermission("manage_stove_dish", signal);
    const memberId = String(formData.get("member_id") ?? "");
    const note = String(formData.get("note") ?? "").trim();

    if (!memberId) {
      return { status: "error", message: "Selecione a pessoa da vez." };
    }
    if (note.length > 300) {
      return { status: "error", message: "O motivo deve ter no máximo 300 caracteres." };
    }

    const { error } = await supabase.rpc("set_dish_rack_cleaning_current_member", {
      target_member_id: memberId,
      change_note: note || null,
    }).abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    refreshDishRackCleaningPages();
    return { status: "success", message: "Pessoa da vez alterada." };
  } catch (error) {
    if (signal.aborted) {
      return {
        status: "error",
        message: "A alteração demorou além do esperado. O rodízio será sincronizado para conferir o resultado.",
      };
    }
    return actionError(error, "Não foi possível alterar a pessoa da vez.");
  }
}

export async function confirmDishRackCleaning(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const signal = AbortSignal.timeout(DISH_RACK_ACTION_TIMEOUT_MS);
  try {
    const { supabase } = await requireActiveProfile(signal);
    const expectedMemberId = String(formData.get("expected_member_id") ?? "");
    const expectedTurnNumberValue = String(formData.get("expected_turn_number") ?? "");
    const expectedTurnNumber = Number(expectedTurnNumberValue);
    const note = String(formData.get("note") ?? "").trim();

    if (
      !expectedMemberId ||
      !/^\d+$/.test(expectedTurnNumberValue) ||
      !Number.isSafeInteger(expectedTurnNumber) ||
      expectedTurnNumber <= 0
    ) {
      return { status: "error", message: "Atualize a página e tente novamente." };
    }
    if (note.length > 300) {
      return {
        status: "error",
        message: "A observação deve ter no máximo 300 caracteres.",
      };
    }

    const { error } = await supabase.rpc("confirm_dish_rack_cleaning", {
      expected_member_id: expectedMemberId,
      expected_turn_number: expectedTurnNumber,
      cleaning_note: note || null,
    }).abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    refreshDishRackCleaningPages();
    return {
      status: "success",
      message: "Limpeza confirmada. Agora é a vez da próxima pessoa.",
    };
  } catch (error) {
    if (signal.aborted) {
      return {
        status: "error",
        message: "A confirmação demorou além do esperado. O rodízio será sincronizado para conferir se a limpeza foi registrada.",
      };
    }
    return actionError(error, "Não foi possível confirmar a limpeza do lava-louça.");
  }
}
