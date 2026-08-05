"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { syncLatestMercadoPagoReport } from "@/lib/mercado-pago";

function valueToMoney(value: FormDataEntryValue | null) {
  let text = String(value ?? "")
    .trim()
    .replace(/\s/g, "");
  if (text.includes(",") && text.includes("."))
    text = text.replace(/\./g, "").replace(",", ".");
  else if (text.includes(",")) text = text.replace(",", ".");
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error("Saldo inválido.");
  return Math.round(parsed * 100) / 100;
}

export async function addManualBalance(formData: FormData) {
  const { profile, supabase } = await requireAdmin();
  const { error } = await supabase.from("wallet_snapshots").insert({
    household_id: profile.household_id,
    balance: valueToMoney(formData.get("balance")),
    source: "manual",
    observed_at: new Date().toISOString(),
    created_by: profile.id,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/app/configuracoes");
}

export async function syncMercadoPago() {
  const { profile, supabase } = await requireAdmin();
  let destination: string;
  try {
    const result = await syncLatestMercadoPagoReport(
      supabase,
      profile.household_id!,
      profile.id,
    );
    revalidatePath("/app/configuracoes");
    const message = result.imported
      ? "Novo relatório importado e próxima atualização solicitada."
      : "Nenhum relatório novo; uma nova atualização foi solicitada ao Mercado Pago.";
    destination = `/app/configuracoes?success=${encodeURIComponent(message)}`;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Falha ao sincronizar.";
    destination = `/app/configuracoes?error=${encodeURIComponent(message)}`;
  }
  redirect(destination);
}
