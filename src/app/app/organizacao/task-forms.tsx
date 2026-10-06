"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { FormActionMessage } from "@/components/form-action-message";
import { SubmitButton } from "@/components/submit-button";
import { initialFormActionState } from "@/lib/form-action-state";
import { createTask, deleteTask, toggleTaskAssignee } from "./actions";

type Member = {
  id: string;
  name: string;
};

export function TaskCreateForm({
  members,
  redirectTo,
  cancelHref,
}: {
  members: Member[];
  redirectTo: string;
  cancelHref: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(createTask, initialFormActionState);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="stack-form">
      <input type="hidden" name="scope" value="geral" />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <div className="form-grid cols-3">
        <label className="field span-2">
          Título
          <input name="title" required placeholder="Ex.: Resolver problema da internet" />
        </label>
        <label className="field">
          Prazo
          <input name="due_date" type="date" />
        </label>
        <label className="field span-3">
          Descrição (opcional)
          <textarea name="description" placeholder="Detalhes úteis" />
        </label>
      </div>
      <div className="form-section">
        <h4>Quem é responsável?</h4>
        <div className="member-check-grid">
          {members.map((member) => (
            <label className="member-check" key={member.id}>
              <input type="checkbox" name="member_ids" value={member.id} />
              <span>{member.name}</span>
            </label>
          ))}
        </div>
        <p className="note">
          Marque todos os moradores se a tarefa é individual para cada um, ou apenas
          um se for responsabilidade de uma única pessoa.
        </p>
      </div>
      <FormActionMessage state={state} />
      <div className="form-actions">
        <SubmitButton pendingLabel="Criando...">Criar tarefa</SubmitButton>
        <Link className="button ghost" href={cancelHref}>
          Cancelar
        </Link>
      </div>
    </form>
  );
}

export function TaskMutationForm({
  mode,
  redirectTo,
  taskId,
  assigneeId,
  done,
  label,
  title,
  className,
}: {
  mode: "toggle" | "delete";
  redirectTo: string;
  taskId?: string;
  assigneeId?: string;
  done?: boolean;
  label: string;
  title?: string;
  className: string;
}) {
  const action = mode === "toggle" ? toggleTaskAssignee : deleteTask;
  const [state, formAction] = useActionState(action, initialFormActionState);

  return (
    <form action={formAction} className="inline-mutation-form">
      {taskId && <input type="hidden" name="task_id" value={taskId} />}
      {assigneeId && <input type="hidden" name="assignee_id" value={assigneeId} />}
      {mode === "toggle" && (
        <input type="hidden" name="done" value={done ? "1" : "0"} />
      )}
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <SubmitButton className={className} pendingLabel="Salvando..." title={title}>
        {label}
      </SubmitButton>
      {state.status === "error" && <FormActionMessage state={state} inline />}
    </form>
  );
}
