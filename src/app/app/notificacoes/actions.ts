"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveProfile } from "@/lib/auth";

function safeLink(value: FormDataEntryValue | null) {
  const link = String(value ?? "");
  // Só destinos internos do app; qualquer outro valor volta para a lista.
  return link.startsWith("/app") && !link.startsWith("//") ? link : "/app/notificacoes";
}

export async function openNotification(formData: FormData) {
  const { supabase } = await requireActiveProfile();
  const id = String(formData.get("id") ?? "");
  if (id) {
    await supabase.rpc("mark_notifications_read", { notification_ids: [id] });
  }
  revalidatePath("/app", "layout");
  redirect(safeLink(formData.get("link")));
}

export async function markAllNotificationsRead() {
  const { supabase } = await requireActiveProfile();
  await supabase.rpc("mark_notifications_read", { notification_ids: null });
  revalidatePath("/app", "layout");
}
