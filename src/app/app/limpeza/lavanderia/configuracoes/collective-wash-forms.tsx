"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { PlusIcon } from "@/components/icons";
import { FormActionMessage } from "@/components/form-action-message";
import { SubmitButton } from "@/components/submit-button";
import { initialFormActionState } from "@/lib/form-action-state";
import { LAUNDRY_ITEM_LABELS } from "@/lib/laundry-rotation";
import { createCollectiveWash, deleteCollectiveWash } from "../actions";

export function CollectiveWashCreateForm({
  minDate,
  members,
}: {
  minDate: string;
  members: { id: string; name: string }[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [itemType, setItemType] = useState("floor_cloths");
  const [state, formAction] = useActionState(
    createCollectiveWash,
    initialFormActionState,
  );

  useEffect(() => {
    if (state.status !== "success") return;
    formRef.current?.reset();
    setItemType("floor_cloths");
    router.refresh();
  }, [router, state]);

  return (
    <form ref={formRef} action={formAction} className="stack-form">
      <label>
        Data
        <input name="wash_date" type="date" required min={minDate} />
      </label>
      <label>
        Tipo de lavagem
        <select
          name="item_type"
          required
          value={itemType}
          onChange={(event) => setItemType(event.target.value)}
        >
          {Object.entries(LAUNDRY_ITEM_LABELS).map(([value, label]) => (
            <option value={value} key={value}>{label}</option>
          ))}
        </select>
      </label>
      <label>
        Responsável {itemType === "bedding" ? "pela roupa de cama" : "(opcional)"}
        <select
          name="responsible_member_id"
          required={itemType === "bedding"}
          defaultValue=""
        >
          <option value="">
            {itemType === "bedding" ? "Selecione o responsável" : "Sem responsável definido"}
          </option>
          {members.map((member) => (
            <option value={member.id} key={member.id}>{member.name}</option>
          ))}
        </select>
        <small>
          O responsável recebe um lembrete por e-mail às 06h no dia agendado.
        </small>
      </label>
      <label>
        Nome personalizado (somente para “Outra lavagem”)
        <input name="custom_label" maxLength={100} placeholder="Ex.: Cortinas da sala" />
      </label>
      <label>
        Observação (opcional)
        <textarea name="note" maxLength={500} rows={3} />
      </label>
      <FormActionMessage state={state} />
      <SubmitButton pendingLabel="Adicionando...">
        <PlusIcon /> Adicionar ao calendário
      </SubmitButton>
    </form>
  );
}

export function CollectiveWashDeleteForm({ washId }: { washId: string }) {
  const router = useRouter();
  const [state, formAction] = useActionState(
    deleteCollectiveWash,
    initialFormActionState,
  );

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state]);

  return (
    <form action={formAction} className="laundry-delete-form">
      <input type="hidden" name="wash_id" value={washId} />
      <SubmitButton className="button danger small" pendingLabel="Removendo...">
        Remover
      </SubmitButton>
      {state.status === "error" && <FormActionMessage state={state} inline />}
    </form>
  );
}
