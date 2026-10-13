"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireActiveProfile, requireAdmin } from "@/lib/auth";
import { isIsoDate, todayIso } from "@/lib/chore-rotation";
import type { FormActionState } from "@/lib/form-action-state";
import { isHouseCleaningAreaSlug } from "@/lib/house-cleaning";

const HOUSE_CLEANING_ACTION_TIMEOUT_MS = 15_000;
const MAX_NOTE_LENGTH = 300;
const UUID_PATTERN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function refreshHouseCleaningPages() {
  revalidatePath("/app/limpeza/mapa");
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

function timedOut(message: string): FormActionState {
  return {
    status: "error",
    message,
  };
}

function formAreaSlug(formData: FormData) {
  return String(formData.get("area_slug") ?? "").trim();
}

export async function initializeHouseCleaningMap(
  _previousState: FormActionState,
  _formData: FormData,
): Promise<FormActionState> {
  const signal = AbortSignal.timeout(HOUSE_CLEANING_ACTION_TIMEOUT_MS);
  try {
    const { supabase } = await requireAdmin(signal);
    const { error } = await supabase
      .rpc("initialize_house_cleaning_map")
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    refreshHouseCleaningPages();
    return {
      status: "success",
      message: "Mapa da casa preparado. Agora você pode configurar cada cômodo.",
    };
  } catch (error) {
    if (signal.aborted) {
      return timedOut(
        "A preparação demorou além do esperado. O mapa será sincronizado para conferir se a configuração foi criada.",
      );
    }
    return actionError(error, "Não foi possível preparar o mapa da casa.");
  }
}

export async function saveHouseCleaningRotation(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const areaSlug = formAreaSlug(formData);
  const memberIds = formData.getAll("member_ids").map(String).filter(Boolean);
  const peoplePerTurnValue = String(formData.get("people_per_turn") ?? "");
  const peoplePerTurn = Number(peoplePerTurnValue);
  const allowIncompleteValues = formData
    .getAll("allow_incomplete_last_group")
    .map(String);
  const allowIncompleteLastGroup = allowIncompleteValues.some((value) =>
    ["true", "on", "1"].includes(value),
  );

  if (!isHouseCleaningAreaSlug(areaSlug)) {
    return { status: "error", message: "Selecione um cômodo válido." };
  }
  if (memberIds.length === 0) {
    return {
      status: "error",
      message: "Inclua pelo menos uma pessoa no rodízio deste cômodo.",
    };
  }
  if (memberIds.some((memberId) => !UUID_PATTERN.test(memberId))) {
    return {
      status: "error",
      message: "A ordem contém uma pessoa inválida. Atualize a página e tente novamente.",
    };
  }
  if (new Set(memberIds).size !== memberIds.length) {
    return {
      status: "error",
      message: "Cada pessoa pode aparecer apenas uma vez na ordem.",
    };
  }
  if (
    !/^\d+$/.test(peoplePerTurnValue) ||
    !Number.isSafeInteger(peoplePerTurn) ||
    peoplePerTurn < 1 ||
    peoplePerTurn > 2 ||
    peoplePerTurn > memberIds.length
  ) {
    return {
      status: "error",
      message: `A equipe deve ter uma ou duas pessoas, sem ultrapassar as ${memberIds.length} pessoa(s) da ordem.`,
    };
  }

  const signal = AbortSignal.timeout(HOUSE_CLEANING_ACTION_TIMEOUT_MS);
  try {
    const { supabase } = await requireAdmin(signal);
    const { error } = await supabase
      .rpc("set_house_cleaning_rotation", {
        target_area_slug: areaSlug,
        ordered_member_ids: memberIds,
        target_people_per_turn: peoplePerTurn,
        target_allow_incomplete_last_group: allowIncompleteLastGroup,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    refreshHouseCleaningPages();
    return { status: "success", message: "Rodízio do cômodo atualizado." };
  } catch (error) {
    if (signal.aborted) {
      return timedOut(
        "A atualização demorou além do esperado. O mapa será sincronizado para conferir o resultado antes de uma nova tentativa.",
      );
    }
    return actionError(error, "Não foi possível atualizar este rodízio.");
  }
}

export async function changeHouseCleaningTurn(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const areaSlug = formAreaSlug(formData);
  const memberId = String(
    formData.get("current_member_id") ?? formData.get("member_id") ?? "",
  ).trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!isHouseCleaningAreaSlug(areaSlug)) {
    return { status: "error", message: "Selecione um cômodo válido." };
  }
  if (!UUID_PATTERN.test(memberId)) {
    return { status: "error", message: "Selecione quem inicia a equipe da vez." };
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return {
      status: "error",
      message: `O motivo deve ter no máximo ${MAX_NOTE_LENGTH} caracteres.`,
    };
  }

  const signal = AbortSignal.timeout(HOUSE_CLEANING_ACTION_TIMEOUT_MS);
  try {
    const { supabase } = await requireAdmin(signal);
    const { error } = await supabase
      .rpc("set_house_cleaning_current_member", {
        target_area_slug: areaSlug,
        target_member_id: memberId,
        change_note: note || null,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    refreshHouseCleaningPages();
    return { status: "success", message: "Equipe da vez alterada." };
  } catch (error) {
    if (signal.aborted) {
      return timedOut(
        "A alteração demorou além do esperado. O mapa será sincronizado para conferir qual equipe ficou registrada.",
      );
    }
    return actionError(error, "Não foi possível alterar a equipe da vez.");
  }
}

export async function registerHouseCleaning(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const areaSlug = formAreaSlug(formData);
  const expectedTurnNumberValue = String(
    formData.get("expected_turn_number") ?? "",
  );
  const expectedTurnNumber = Number(expectedTurnNumberValue);
  const cleanerMemberIds = formData
    .getAll("cleaner_member_ids")
    .map(String)
    .filter(Boolean);
  const cleanedOn = String(
    formData.get("cleaned_on") ?? formData.get("cleaning_date") ?? "",
  ).trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!isHouseCleaningAreaSlug(areaSlug)) {
    return { status: "error", message: "Selecione um cômodo válido." };
  }
  if (
    !/^\d+$/.test(expectedTurnNumberValue) ||
    !Number.isSafeInteger(expectedTurnNumber) ||
    expectedTurnNumber <= 0 ||
    cleanerMemberIds.length === 0 ||
    cleanerMemberIds.length > 2 ||
    cleanerMemberIds.some((memberId) => !UUID_PATTERN.test(memberId)) ||
    new Set(cleanerMemberIds).size !== cleanerMemberIds.length
  ) {
    return {
      status: "error",
      message: "O turno mudou ou está incompleto. Atualize a página e tente novamente.",
    };
  }
  if (cleanedOn && (!isIsoDate(cleanedOn) || cleanedOn > todayIso())) {
    return {
      status: "error",
      message: "Informe uma data de limpeza válida, sem usar uma data futura.",
    };
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return {
      status: "error",
      message: `A observação deve ter no máximo ${MAX_NOTE_LENGTH} caracteres.`,
    };
  }

  const signal = AbortSignal.timeout(HOUSE_CLEANING_ACTION_TIMEOUT_MS);
  try {
    const { supabase } = await requireActiveProfile(signal);
    const { error } = await supabase
      .rpc("register_house_cleaning", {
        target_area_slug: areaSlug,
        expected_turn_number: expectedTurnNumber,
        cleaner_member_ids: cleanerMemberIds,
        cleaning_date: cleanedOn || null,
        cleaning_note: note || null,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    refreshHouseCleaningPages();
    return {
      status: "success",
      message: "Limpeza registrada. O histórico e a próxima indicação foram atualizados.",
    };
  } catch (error) {
    if (signal.aborted) {
      return timedOut(
        "A confirmação demorou além do esperado. O mapa será sincronizado para conferir se a limpeza foi registrada.",
      );
    }
    return actionError(error, "Não foi possível confirmar a limpeza deste cômodo.");
  }
}
