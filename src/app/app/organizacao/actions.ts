"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import {
  can,
  requireActiveProfile,
  requirePermission,
} from "@/lib/auth";
import type { FormActionState } from "@/lib/form-action-state";
import {
  RECEIPT_BUCKET,
  slugifyReceiptFileName,
  validateReceiptMetadata,
  validateStoredReceiptMetadata,
} from "@/lib/storage";
import { createServiceClient } from "@/lib/supabase/service";

const SHOPPING_PURCHASE_TIMEOUT_MS = 15_000;
const SHOPPING_MUTATION_TIMEOUT_MS = 15_000;

function destination(formData: FormData, fallback: string) {
  const value = String(formData.get("redirect_to") ?? "");
  return value.startsWith("/app") ? value : fallback;
}

function pathOf(url: string) {
  return url.split("?")[0] || "/app";
}

function withRefresh(url: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}updated=${Date.now()}`;
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

// Replica round(numeric, 2) do PostgreSQL sem depender do arredondamento
// binário do JavaScript (por exemplo, 1,005 precisa resultar em 1,01).
function decimalHundredths(value: FormDataEntryValue | null): number | null {
  let text = String(value ?? "").trim().replace(/\s/g, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const fraction = `${match[3] ?? ""}000`;
  let hundredths = Number(match[2]) * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) hundredths += 1;
  if (!Number.isSafeInteger(hundredths)) return null;
  return match[1] === "-" ? -hundredths : hundredths;
}

// ----------------------------------------------------------------------
// Tarefas (organização / calendário do Casa em dia)
// ----------------------------------------------------------------------

export async function createTask(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requirePermission("manage_tasks");
  const scope = String(formData.get("scope") ?? "geral") === "casa" ? "casa" : "geral";
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { status: "error", message: "Informe um título para a tarefa." };
  const description = String(formData.get("description") ?? "").trim() || null;
  const dueDate = String(formData.get("due_date") ?? "") || null;
  const memberIds = Array.from(
    new Set(formData.getAll("member_ids").map(String).filter(Boolean)),
  );

  try {
    const { error } = await supabase.rpc("create_task_with_assignees", {
      selected_scope: scope,
      task_title: title,
      task_description: description,
      task_due_date: dueDate,
      assignee_member_ids: memberIds,
    });
    if (error) return { status: "error", message: error.message };
    revalidatePath(pathOf(returnTo));
    return { status: "success", message: "Tarefa criada." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível criar a tarefa.",
    };
  }
}

export async function toggleTaskAssignee(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  // Qualquer morador ativo pode tentar marcar uma tarefa como concluída; a
  // política de RLS garante que só é possível alterar a própria atribuição,
  // a não ser que o perfil tenha a permissão manage_tasks.
  const { supabase } = await requireActiveProfile();
  const assigneeId = String(formData.get("assignee_id"));
  const done = String(formData.get("done")) === "1";

  try {
    const { data, error } = await supabase
      .from("task_assignees")
      .update({ done, done_at: done ? new Date().toISOString() : null })
      .eq("id", assigneeId)
      .select("id")
      .maybeSingle();
    if (error) return { status: "error", message: error.message };
    if (!data) return { status: "error", message: "Responsável não encontrado." };

    revalidatePath(pathOf(returnTo));
    return {
      status: "success",
      message: done ? "Tarefa concluída." : "Tarefa reaberta.",
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível atualizar a tarefa.",
    };
  }
}

export async function deleteTask(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requirePermission("manage_tasks");
  try {
    const { data, error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", String(formData.get("task_id")))
      .eq("household_id", profile.household_id)
      .select("id")
      .maybeSingle();
    if (error) return { status: "error", message: error.message };
    if (!data) return { status: "error", message: "Tarefa não encontrada." };
    revalidatePath(pathOf(returnTo));
    return { status: "success", message: "Tarefa excluída." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível excluir a tarefa.",
    };
  }
}

// ----------------------------------------------------------------------
// Lista de compras
// ----------------------------------------------------------------------

export async function addShoppingItem(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requirePermission("manage_shopping");
  try {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { status: "error", message: "Informe o nome do item." };
    const quantityPlanned = decimal(formData.get("quantity_planned"));
    const unitPriceInput = String(formData.get("unit_price") ?? "").trim();
    const unitPriceCents = unitPriceInput
      ? decimalHundredths(formData.get("unit_price"))
      : null;
    if (quantityPlanned !== null && quantityPlanned <= 0) {
      return {
        status: "error",
        message: "A quantidade planejada precisa ser maior que zero.",
      };
    }
    if (unitPriceInput && (unitPriceCents === null || unitPriceCents < 0)) {
      return {
        status: "error",
        message: "Informe um valor unitário válido.",
      };
    }
    const { error } = await supabase.from("shopping_items").insert({
      household_id: profile.household_id,
      name,
      note: String(formData.get("note") ?? "").trim() || null,
      category: String(formData.get("category") ?? "").trim() || null,
      quantity_planned: quantityPlanned,
      unit_price: unitPriceCents === null ? null : unitPriceCents / 100,
      added_by: profile.id,
    });
    if (error) return { status: "error", message: error.message };
    revalidatePath(pathOf(returnTo));
    return { status: "success", message: "Item adicionado à lista." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível adicionar o item.",
    };
  }
}

export async function toggleShoppingChecked(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const { supabase } = await requirePermission("manage_shopping");
  try {
    const itemId = String(formData.get("item_id"));
    const nextStatus = String(formData.get("next_status") ?? "checked");
    if (!["list", "checked"].includes(nextStatus)) {
      return { status: "error", message: "Status do item inválido." };
    }
    const patch: Record<string, unknown> = { status: nextStatus };
    if (nextStatus === "checked") patch.checked_at = new Date().toISOString();
    if (nextStatus === "list") patch.checked_at = null;
    const { data, error } = await supabase
      .from("shopping_items")
      .update(patch)
      .eq("id", itemId)
      .in("status", ["list", "checked"])
      .select("id")
      .maybeSingle();
    if (error) return { status: "error", message: error.message };
    if (!data) return { status: "error", message: "Item não encontrado ou já comprado." };
    revalidatePath(pathOf(returnTo));
    return {
      status: "success",
      message: nextStatus === "checked" ? "Item marcado no carrinho." : "Item devolvido à lista.",
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível atualizar o item.",
    };
  }
}

export async function updateShoppingItem(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requirePermission("manage_shopping");
  try {
    const itemId = String(formData.get("item_id") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    const quantityPlanned = decimal(formData.get("quantity_planned"));
    const unitPriceInput = String(formData.get("unit_price") ?? "").trim();
    const unitPriceCents = unitPriceInput
      ? decimalHundredths(formData.get("unit_price"))
      : null;
    if (!name) return { status: "error", message: "Informe o nome do item." };
    if (quantityPlanned !== null && quantityPlanned <= 0) {
      return {
        status: "error",
        message: "A quantidade planejada precisa ser maior que zero.",
      };
    }
    if (unitPriceInput && (unitPriceCents === null || unitPriceCents < 0)) {
      return {
        status: "error",
        message: "Informe um valor unitário válido.",
      };
    }

    const { data, error } = await supabase
      .from("shopping_items")
      .update({
        name,
        quantity_planned: quantityPlanned,
        unit_price: unitPriceCents === null ? null : unitPriceCents / 100,
      })
      .eq("id", itemId)
      .eq("household_id", profile.household_id)
      .in("status", ["list", "checked"])
      .select("id")
      .maybeSingle();
    if (error) return { status: "error", message: error.message };
    if (!data) return { status: "error", message: "Item não encontrado ou já comprado." };
    revalidatePath(pathOf(returnTo));
    return { status: "success", message: "Item atualizado." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível atualizar o item.",
    };
  }
}

export async function recordShoppingPurchase(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const signal = AbortSignal.timeout(SHOPPING_PURCHASE_TIMEOUT_MS);
  try {
    const { supabase } = await requirePermission("manage_shopping", signal);
    const itemIds = Array.from(
      new Set(formData.getAll("selected_item_ids").map(String).filter(Boolean)),
    );
    const scope = String(formData.get("purchase_scope") ?? "");
    const payerMemberId = String(formData.get("paid_by_member_id") ?? "");
    const participantIds = Array.from(
      new Set(formData.getAll("participant_ids").map(String).filter(Boolean)),
    );
    const splitMode = String(formData.get("split_mode") ?? "equal");
    const quantityHundredths = itemIds.map((itemId) =>
      decimalHundredths(formData.get(`quantity_${itemId}`)),
    );
    const unitPriceHundredths = itemIds.map((itemId) =>
      decimalHundredths(formData.get(`unit_price_${itemId}`)),
    );
    const quantities = quantityHundredths.map((value) =>
      value === null ? null : value / 100,
    );
    const unitPrices = unitPriceHundredths.map((value) =>
      value === null ? null : value / 100,
    );

    if (itemIds.length === 0) return { status: "error", message: "Selecione pelo menos um item." };
    if (quantities.some((value) => value === null || value <= 0)) {
      return { status: "error", message: "Informe uma quantidade válida para todos os itens." };
    }
    if (unitPrices.some((value) => value === null || value < 0)) {
      return { status: "error", message: "Informe o valor unitário de todos os itens." };
    }
    if (!payerMemberId) return { status: "error", message: "Selecione quem pagou a compra." };
    if (!["equal", "custom"].includes(splitMode)) {
      return { status: "error", message: "Tipo de divisão inválido." };
    }

    let customShareCents: Record<string, number> | null = null;
    if (splitMode === "custom") {
      customShareCents = {};
      for (const participantId of participantIds) {
        const amountCents = decimalHundredths(formData.get(`share_${participantId}`));
        if (amountCents === null || amountCents < 0) {
          return {
            status: "error",
            message: "Informe um valor válido para cada participante.",
          };
        }
        customShareCents[participantId] = amountCents;
      }

      const purchaseTotalCents = itemIds.reduce((sum, _itemId, index) => {
        return (
          sum +
          Math.round(
            ((quantityHundredths[index] ?? 0) *
              (unitPriceHundredths[index] ?? 0)) /
              100,
          )
        );
      }, 0);
      const customTotalCents = Object.values(customShareCents).reduce(
        (sum, amount) => sum + amount,
        0,
      );
      if (customTotalCents !== purchaseTotalCents) {
        return {
          status: "error",
          message: `A divisão personalizada precisa somar ${(purchaseTotalCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`,
        };
      }
    }

    const { error } = await supabase
      .rpc("record_multi_item_shopping_purchase_v2", {
        target_item_ids: itemIds,
        purchased_quantities: quantities as number[],
        purchased_unit_prices: unitPrices as number[],
        selected_scope: scope,
        payer_member_id: payerMemberId,
        participant_member_ids: participantIds,
        selected_split_mode: splitMode,
        custom_share_cents: customShareCents,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    revalidatePath(pathOf(returnTo));
    revalidatePath("/app/eu");
    revalidatePath("/app/limpeza");
    revalidatePath("/app/limpeza/agua");
    return { status: "success", message: "Compra registrada com sucesso." };
  } catch (error) {
    unstable_rethrow(error);
    if (signal.aborted) {
      return {
        status: "error",
        message: "O registro demorou além do esperado e foi cancelado. Os itens e valores foram mantidos; tente novamente.",
      };
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível registrar a compra.",
    };
  }
}

export async function resetShoppingPurchase(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const signal = AbortSignal.timeout(SHOPPING_MUTATION_TIMEOUT_MS);
  try {
    const { supabase } = await requirePermission("manage_shopping");
    const purchaseId = String(formData.get("purchase_id") ?? "");
    const { count: pendingReceipts } = await supabase
      .from("shopping_purchase_shares")
      .select("id", { count: "exact", head: true })
      .eq("purchase_id", purchaseId)
      .eq("payment_status", "pending")
      .not("receipt_path", "is", null)
      .abortSignal(signal);
    signal.throwIfAborted();
    if ((pendingReceipts ?? 0) > 0) {
      return {
        status: "error",
        message: "Confirme o comprovante pendente antes de desfazer esta compra.",
      };
    }
    const { error } = await supabase.rpc("reset_shopping_purchase", {
      target_purchase_id: purchaseId,
    }).abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    revalidatePath(pathOf(returnTo));
    revalidatePath("/app/eu");
    revalidatePath("/app/limpeza");
    revalidatePath("/app/limpeza/agua");
    return { status: "success", message: "Itens devolvidos para a lista." };
  } catch (error) {
    unstable_rethrow(error);
    if (signal.aborted) {
      return {
        status: "error",
        message: "A operação demorou além do esperado e foi interrompida. O histórico será sincronizado para conferir o resultado.",
      };
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível desfazer a compra.",
    };
  }
}

export async function removeItemFromShoppingPurchase(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const signal = AbortSignal.timeout(SHOPPING_MUTATION_TIMEOUT_MS);
  try {
    const { supabase } = await requirePermission("manage_shopping");
    const purchaseId = String(formData.get("purchase_id") ?? "");
    const itemId = String(formData.get("item_id") ?? "");
    if (!purchaseId || !itemId) {
      return { status: "error", message: "Compra ou item não informado." };
    }

    const { error } = await supabase.rpc("remove_item_from_shopping_purchase", {
      target_purchase_id: purchaseId,
      target_item_id: itemId,
    }).abortSignal(signal);
    signal.throwIfAborted();
    if (error) return { status: "error", message: error.message };

    revalidatePath(pathOf(returnTo));
    revalidatePath("/app/eu");
    revalidatePath("/app/limpeza");
    revalidatePath("/app/limpeza/agua");
    return { status: "success", message: "Item retirado e devolvido para a lista." };
  } catch (error) {
    unstable_rethrow(error);
    if (signal.aborted) {
      return {
        status: "error",
        message: "A retirada demorou além do esperado e foi interrompida. O histórico será sincronizado para conferir o resultado.",
      };
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível retirar o item.",
    };
  }
}

export async function deleteShoppingItem(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/organizacao");
  const { profile, supabase } = await requirePermission("manage_shopping");
  try {
    const itemId = String(formData.get("item_id"));
    const { data, error } = await supabase
      .from("shopping_items")
      .delete()
      .eq("id", itemId)
      .eq("household_id", profile.household_id)
      .in("status", ["list", "checked"])
      .select("id")
      .maybeSingle();
    if (error) return { status: "error", message: error.message };
    if (!data) return { status: "error", message: "Item não encontrado ou já comprado." };
    revalidatePath(pathOf(returnTo));
    revalidatePath("/app/eu");
    return { status: "success", message: "Item excluído." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Não foi possível excluir o item.",
    };
  }
}

type ShoppingUploadResult =
  | { ok: true; path?: string; token?: string; message: string }
  | { ok: false; message: string };

async function resolveShoppingReceiptShare(shareId: string) {
  const { profile, supabase } = await requireActiveProfile();
  const { data: share, error } = await supabase
    .from("shopping_purchase_shares")
    .select("id,member_id,receipt_path,purchase:shopping_purchases(household_id)")
    .eq("id", shareId)
    .single();
  const purchase = Array.isArray(share?.purchase) ? share.purchase[0] : share?.purchase;
  if (error || !share || !purchase || purchase.household_id !== profile.household_id) {
    throw new Error("Dívida de compra não encontrada.");
  }
  if (
    share.member_id !== profile.member_id &&
    !can(profile, "manage_shopping_settlements")
  ) {
    throw new Error("Somente o devedor ou o administrador pode enviar este comprovante.");
  }
  return { profile, supabase, receiptPath: share.receipt_path };
}

export async function prepareShoppingNetReceiptUpload(
  shareId: string,
  file: { name: string; type: string; size: number },
): Promise<ShoppingUploadResult> {
  try {
    const validationError = validateReceiptMetadata(file);
    if (validationError) return { ok: false, message: validationError };
    const { profile, receiptPath } = await resolveShoppingReceiptShare(shareId);
    if (receiptPath) {
      return { ok: false, message: "Esta dívida já possui um comprovante enviado." };
    }
    const safeName = slugifyReceiptFileName(file.name || "arquivo") || "arquivo";
    const path = `${profile.household_id}/shopping-net/${shareId}/${crypto.randomUUID()}-${safeName}`;
    const { data, error } = await createServiceClient().storage
      .from(RECEIPT_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data?.token) {
      return {
        ok: false,
        message: error?.message ?? "Não foi possível preparar o envio.",
      };
    }
    return { ok: true, path, token: data.token, message: "Envio autorizado." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Não foi possível preparar o envio.",
    };
  }
}

export async function finalizeShoppingNetReceiptUpload(
  shareId: string,
  paymentAmount: string,
  uploaded: { path: string; name: string },
): Promise<ShoppingUploadResult> {
  try {
    const paidAmount = decimal(paymentAmount);
    if (paidAmount === null || paidAmount <= 0) {
      return { ok: false, message: "Informe o valor que foi pago." };
    }

    const { profile, supabase, receiptPath } = await resolveShoppingReceiptShare(shareId);
    const expectedPrefix = `${profile.household_id}/shopping-net/${shareId}/`;
    if (!uploaded.path.startsWith(expectedPrefix)) {
      return { ok: false, message: "Caminho do comprovante inválido." };
    }

    const service = createServiceClient();
    if (receiptPath) {
      await service.storage.from(RECEIPT_BUCKET).remove([uploaded.path]);
      return { ok: false, message: "Esta dívida já possui um comprovante enviado." };
    }
    const objectName = uploaded.path.slice(uploaded.path.lastIndexOf("/") + 1);
    const folder = uploaded.path.slice(0, uploaded.path.lastIndexOf("/"));
    const { data: objects, error: listError } = await service.storage
      .from(RECEIPT_BUCKET)
      .list(folder, { limit: 10, search: objectName });
    const storedObject = (objects ?? []).find((object) => object.name === objectName);
    if (listError || !storedObject) {
      return { ok: false, message: "O comprovante enviado não foi encontrado." };
    }
    const storedValidationError = validateStoredReceiptMetadata(
      storedObject.metadata as Record<string, unknown> | null,
    );
    if (storedValidationError) {
      await service.storage.from(RECEIPT_BUCKET).remove([uploaded.path]);
      return { ok: false, message: storedValidationError };
    }

    const { error } = await supabase.rpc("submit_shopping_net_receipt", {
      target_share_id: shareId,
      uploaded_path: uploaded.path,
      uploaded_name: uploaded.name || "comprovante",
      paid_amount: paidAmount,
    });
    if (error) {
      await service.storage.from(RECEIPT_BUCKET).remove([uploaded.path]);
      return { ok: false, message: error.message };
    }

    revalidatePath("/app/organizacao");
    revalidatePath("/app/eu");
    return {
      ok: true,
      message: `Comprovante de ${paidAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} enviado. O valor aguarda confirmação.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Não foi possível salvar o comprovante.",
    };
  }
}

export async function confirmShoppingNetPayment(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/eu");
  const { supabase } = await requireActiveProfile();
  const paymentId = String(formData.get("payment_id") ?? "");
  if (!paymentId) {
    return { status: "error", message: "Pagamento não informado." };
  }
  const { error } = await supabase.rpc("confirm_shopping_net_payment", {
    target_payment_id: paymentId,
  });
  if (error) return { status: "error", message: error.message };

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  revalidatePath(pathOf(returnTo));
  return {
    status: "success",
    message: "Pagamento confirmado. Se houver saldo restante, ele continua em aberto.",
  };
}

export async function recordShoppingNetPaymentAsAdmin(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const returnTo = destination(formData, "/app/eu");
  const { supabase } = await requirePermission("manage_shopping_settlements");
  const shareId = String(formData.get("share_id") ?? "");
  const paidAmount = decimal(formData.get("payment_amount"));

  if (!shareId) {
    return { status: "error", message: "Acerto não informado." };
  }
  if (paidAmount === null || paidAmount <= 0) {
    return { status: "error", message: "Informe o valor que foi pago." };
  }

  const { error } = await supabase.rpc("record_shopping_net_payment_as_admin", {
    target_share_id: shareId,
    paid_amount: paidAmount,
  });
  if (error) return { status: "error", message: error.message };

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  revalidatePath("/app");
  revalidatePath(pathOf(returnTo));
  return {
    status: "success",
    message: `Pagamento de ${paidAmount.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    })} registrado pelo administrador sem comprovante.`,
  };
}

export async function settleZeroShoppingBalance(formData: FormData) {
  const returnTo = destination(formData, "/app/eu");
  const { supabase } = await requireActiveProfile();
  const counterpartyMemberId = String(formData.get("counterparty_member_id") ?? "");
  const { error } = await supabase.rpc("settle_zero_shopping_balance", {
    counterparty_member_id: counterpartyMemberId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  redirect(`${pathOf(returnTo)}?success=${encodeURIComponent("Dívidas compensadas e quitadas.")}`);
}

export async function settleZeroShoppingBalanceAsAdmin(formData: FormData) {
  const returnTo = destination(formData, "/app/eu");
  const { supabase } = await requirePermission("manage_shopping_settlements");
  const firstMemberId = String(formData.get("first_member_id") ?? "");
  const secondMemberId = String(formData.get("second_member_id") ?? "");
  if (!firstMemberId || !secondMemberId || firstMemberId === secondMemberId) {
    throw new Error("Informe dois moradores diferentes para a compensação.");
  }

  const { error } = await supabase.rpc("settle_zero_shopping_balance_as_admin", {
    first_member_id: firstMemberId,
    second_member_id: secondMemberId,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/app/organizacao");
  revalidatePath("/app/eu");
  redirect(
    `${pathOf(returnTo)}?success=${encodeURIComponent("Acerto compensado pelo administrador.")}`,
  );
}
