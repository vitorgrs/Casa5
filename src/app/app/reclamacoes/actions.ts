"use server";

import { revalidatePath } from "next/cache";
import { requireActiveProfile } from "@/lib/auth";
import type { FormActionState } from "@/lib/form-action-state";

export async function submitAnonymousComplaint(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const subject = String(formData.get("subject") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  if (subject.length < 3 || subject.length > 120) {
    return { status: "error", message: "O assunto deve ter entre 3 e 120 caracteres." };
  }
  if (message.length < 10 || message.length > 3000) {
    return { status: "error", message: "A reclamação deve ter entre 10 e 3000 caracteres." };
  }

  try {
    const { supabase } = await requireActiveProfile();
    const { data, error } = await supabase.rpc("submit_anonymous_complaint", {
      complaint_subject: subject,
      complaint_message: message,
    });

    if (error) return { status: "error", message: error.message };

    const result = Array.isArray(data) ? data[0] : data;
    const protocol = result?.complaint_protocol
      ? ` Protocolo: ${result.complaint_protocol}.`
      : "";
    revalidatePath("/app/reclamacoes");
    return {
      status: "success",
      message: `Reclamação enviada anonimamente e encaminhada para análise.${protocol}`,
    };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Não foi possível enviar a reclamação.",
    };
  }
}
