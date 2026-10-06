"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { MessageIcon } from "@/components/icons";
import { FormActionMessage } from "@/components/form-action-message";
import { SubmitButton } from "@/components/submit-button";
import { initialFormActionState } from "@/lib/form-action-state";
import { submitAnonymousComplaint } from "./actions";

export function ComplaintForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(
    submitAnonymousComplaint,
    initialFormActionState,
  );

  useEffect(() => {
    if (state.status !== "success") return;
    formRef.current?.reset();
    router.refresh();
  }, [router, state]);

  return (
    <form ref={formRef} action={formAction} className="stack-form">
      <label>
        Assunto
        <input
          name="subject"
          required
          minLength={3}
          maxLength={120}
          placeholder="Ex.: Barulho recorrente durante a madrugada"
        />
      </label>
      <label>
        Reclamação
        <textarea
          name="message"
          required
          minLength={10}
          maxLength={3000}
          rows={7}
          placeholder="Explique o que aconteceu e, se for útil, informe datas e horários."
        />
      </label>
      <p className="note complaint-note">
        O conteúdo recebe um protocolo privado. A associação usada para mostrar
        seus próprios protocolos não é exibida ao administrador.
      </p>
      <FormActionMessage state={state} />
      <SubmitButton pendingLabel="Enviando reclamação...">
        <MessageIcon /> Enviar anonimamente
      </SubmitButton>
    </form>
  );
}
