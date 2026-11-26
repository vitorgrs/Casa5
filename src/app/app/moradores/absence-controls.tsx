"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { FormActionMessage } from "@/components/form-action-message";
import { SubmitButton } from "@/components/submit-button";
import { formatHouseDate } from "@/lib/chore-rotation";
import { initialFormActionState } from "@/lib/form-action-state";
import { markMemberAway, markMemberReturned } from "./actions";

type Absence = {
  left_on: string;
  returned_on: string | null;
};

/**
 * Controles de presença de um morador. Sem ausência: marca a saída. Com
 * ausência em vigor: registra a volta. Com saída agendada (data futura):
 * permite cancelar o agendamento.
 */
export function AbsenceControls({
  memberId,
  memberName,
  today,
  absence,
}: {
  memberId: string;
  memberName: string;
  today: string;
  absence: Absence | null;
}) {
  const router = useRouter();
  const [awayState, awayAction] = useActionState(markMemberAway, initialFormActionState);
  const [returnState, returnAction] = useActionState(
    markMemberReturned,
    initialFormActionState,
  );

  useEffect(() => {
    if (awayState.status === "success" || returnState.status === "success") {
      router.refresh();
    }
  }, [awayState, returnState, router]);

  const firstName = memberName.split(" ")[0];
  const scheduled = absence && absence.left_on > today;

  if (!absence) {
    return (
      <details className="disclosure">
        <summary>Marcar saída de casa</summary>
        <form action={awayAction} className="stack-form disclosure-body">
          <input type="hidden" name="member_id" value={memberId} />
          <p className="note">
            {firstName} sai de todos os rodízios a partir da data informada e,
            ao voltar, retoma a mesma posição.
          </p>
          <label className="field">
            Fora a partir de
            <input type="date" name="away_from" defaultValue={today} required />
          </label>
          <label className="field">
            Observação (opcional)
            <input name="note" maxLength={300} autoComplete="off" placeholder="Ex.: viagem de férias…" />
          </label>
          <SubmitButton className="button secondary" pendingLabel="Registrando…">
            Confirmar saída
          </SubmitButton>
          <FormActionMessage state={awayState} inline />
        </form>
      </details>
    );
  }

  if (scheduled) {
    return (
      <form action={returnAction} className="stack-form presence-form">
        <input type="hidden" name="member_id" value={memberId} />
        <input type="hidden" name="returned_on" value={absence.left_on} />
        <input type="hidden" name="cancel" value="1" />
        <SubmitButton className="button ghost" pendingLabel="Cancelando…">
          Cancelar saída de {formatHouseDate(absence.left_on)}
        </SubmitButton>
        <FormActionMessage state={returnState} inline />
      </form>
    );
  }

  return (
    <form action={returnAction} className="stack-form presence-form">
      <input type="hidden" name="member_id" value={memberId} />
      <label className="field">
        Voltou em
        <input
          type="date"
          name="returned_on"
          defaultValue={today}
          min={absence.left_on}
          required
        />
      </label>
      <SubmitButton className="button primary" pendingLabel="Registrando…">
        Registrar volta de {firstName}
      </SubmitButton>
      <FormActionMessage state={returnState} inline />
    </form>
  );
}
