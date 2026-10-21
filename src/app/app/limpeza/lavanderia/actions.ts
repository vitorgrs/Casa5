"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { isIsoDate, todayIso } from "@/lib/chore-rotation";
import type { FormActionState } from "@/lib/form-action-state";
import {
  LAUNDRY_ITEM_LABELS,
  type LaundryItemType,
} from "@/lib/laundry-rotation";

function refreshLaundryPages() {
  revalidatePath("/app/limpeza/lavanderia");
  revalidatePath("/app/limpeza/lavanderia/configuracoes");
}

export async function saveLaundryRotation(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const anchorDate = String(formData.get("anchor_date") ?? "");
  const anchorMemberId = String(formData.get("anchor_member_id") ?? "");
  const gapDays = Number(formData.get("gap_days") ?? 2);
  const peoplePerDay = Number(formData.get("people_per_day") ?? 2);
  const allowIncompleteLastGroup =
    String(formData.get("allow_incomplete_last_group") ?? "") === "true";
  const memberIds = formData.getAll("member_ids").map(String).filter(Boolean);

  if (!isIsoDate(anchorDate)) {
    return { status: "error", message: "Informe uma data de referência válida." };
  }
  if (anchorDate < todayIso()) {
    return {
      status: "error",
      message: "A primeira lavagem da nova configuração deve ser hoje ou no futuro.",
    };
  }
  if (!anchorMemberId || !memberIds.includes(anchorMemberId)) {
    return { status: "error", message: "Escolha o grupo que lava na data de referência." };
  }
  if (!Number.isInteger(gapDays) || gapDays < 0 || gapDays > 30) {
    return { status: "error", message: "O intervalo deve estar entre 0 e 30 dias." };
  }
  if (
    !Number.isInteger(peoplePerDay) ||
    peoplePerDay < 1 ||
    peoplePerDay > memberIds.length
  ) {
    return {
      status: "error",
      message: `A quantidade por dia deve estar entre 1 e ${memberIds.length}.`,
    };
  }
  const anchorIndex = memberIds.indexOf(anchorMemberId);
  if (allowIncompleteLastGroup && anchorIndex % peoplePerDay !== 0) {
    return {
      status: "error",
      message: "Escolha o início de um dos grupos mostrados para a data de referência.",
    };
  }

  try {
    const { supabase } = await requirePermission("manage_laundry");
    const { error } = await supabase.rpc("set_laundry_rotation", {
      rotation_anchor_date: anchorDate,
      rotation_anchor_member_id: anchorMemberId,
      rotation_gap_days: gapDays,
      rotation_people_per_day: peoplePerDay,
      rotation_allow_incomplete_last_group: allowIncompleteLastGroup,
      ordered_member_ids: memberIds,
    });
    if (error) return { status: "error", message: error.message };

    refreshLaundryPages();
    return {
      status: "success",
      message: "Nova escala salva a partir de hoje. As datas anteriores foram preservadas.",
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível salvar a escala.",
    };
  }
}

export async function createCollectiveWash(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const washDate = String(formData.get("wash_date") ?? "");
  const itemType = String(formData.get("item_type") ?? "") as LaundryItemType;
  const customLabel = String(formData.get("custom_label") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const responsibleMemberId = String(
    formData.get("responsible_member_id") ?? "",
  ).trim();

  if (!isIsoDate(washDate)) {
    return { status: "error", message: "Informe uma data válida para a lavagem." };
  }
  if (washDate < todayIso()) {
    return {
      status: "error",
      message: "A lavagem coletiva deve ser cadastrada para hoje ou uma data futura.",
    };
  }
  if (!(itemType in LAUNDRY_ITEM_LABELS)) {
    return { status: "error", message: "Selecione um tipo de lavagem válido." };
  }
  if (itemType === "bedding" && !responsibleMemberId) {
    return {
      status: "error",
      message: "Escolha quem será responsável por lavar a roupa de cama.",
    };
  }
  if (itemType === "other" && (customLabel.length < 2 || customLabel.length > 100)) {
    return { status: "error", message: "Informe um nome de 2 a 100 caracteres." };
  }
  if (note.length > 500) {
    return { status: "error", message: "A observação deve ter no máximo 500 caracteres." };
  }

  try {
    const { profile, supabase } = await requirePermission("manage_laundry");
    if (responsibleMemberId) {
      const { data: responsible, error: responsibleError } = await supabase
        .from("household_members")
        .select("id")
        .eq("household_id", profile.household_id)
        .eq("id", responsibleMemberId)
        .eq("active", true)
        .maybeSingle();
      if (responsibleError) {
        return { status: "error", message: responsibleError.message };
      }
      if (!responsible) {
        return {
          status: "error",
          message: "O responsável selecionado não está ativo nesta casa.",
        };
      }
    }
    const { error } = await supabase.from("laundry_collective_washes").insert({
      household_id: profile.household_id,
      wash_date: washDate,
      item_type: itemType,
      custom_label: itemType === "other" ? customLabel : null,
      note: note || null,
      responsible_member_id: responsibleMemberId || null,
      created_by: profile.id,
    });
    if (error) return { status: "error", message: error.message };

    refreshLaundryPages();
    return { status: "success", message: "Lavagem coletiva adicionada ao calendário." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível adicionar a lavagem.",
    };
  }
}

export async function deleteCollectiveWash(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const washId = String(formData.get("wash_id") ?? "");
  if (!washId) return { status: "error", message: "Lavagem não informada." };

  try {
    const { profile, supabase } = await requirePermission("manage_laundry");
    const { data, error } = await supabase
      .from("laundry_collective_washes")
      .delete()
      .eq("id", washId)
      .eq("household_id", profile.household_id)
      .select("id")
      .maybeSingle();
    if (error) return { status: "error", message: error.message };
    if (!data) return { status: "error", message: "Lavagem não encontrada." };

    refreshLaundryPages();
    return { status: "success", message: "Lavagem coletiva removida." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível remover a lavagem.",
    };
  }
}
