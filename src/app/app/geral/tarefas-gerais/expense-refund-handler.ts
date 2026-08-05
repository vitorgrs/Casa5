"use server";

import { requireActiveProfile } from "@/lib/auth";
import { supabase } from "@/lib/supabase/client";

// Esta função executa um processamento assíncrono de reembolso de despesas
// Ela será chamada a partir do backend quando um reembolso for criado/atualizado
export async function processRefund(formData: FormData) {
  const { profile, supabase } = await requireActiveProfile();

  const refundId = String(formData.get("refund_id"));
  const status = String(formData.get("status"));

  // Obter dados do reembolso
  const { data: refund, error } = await supabase
    .from("expense_refunds")
    .select("*, expenses(*) ")
    .eq("id", refundId)
    .single();

  if (error || !refund) throw new Error(error?.message ?? "Reembolso não encontrado.");

  // Calcular divisão entre membros (exemplo)
  const { data: shares } = await supabase
    .from("expense_shares")
    .select("member_id, amount")
    .eq("expense_id", refund.expense_id);

  const memberData: any = {};
  shares?.forEach((share) => {
    memberData[share.member_id] = share.amount;
  });

  // Atualizar members_data com informações da divisão
  const { error: updateError } = await supabase
    .from("expense_refunds")
    .update({
      members_data: memberData,
      updated_by: profile.id,
    })
    .eq("id", refundId);

  if (updateError) throw new Error(updateError.message);

  // Se status for 'distribuido', atualizar a tarefa correspondente
  if (status === "distribuido") {
    const { error: taskError } = await supabase
      .from("tasks_tasks")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_by: profile.id,
      })
      .eq("expense_refund_id", refundId);

    if (taskError) throw new Error(taskError.message);
  }

  return { success: true };
}
