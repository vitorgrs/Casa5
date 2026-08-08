"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";

type Action = (formData: FormData) => void | Promise<void>;

export function MarkPaidControl({
  action,
  shareId,
  redirectTo,
  hasReceipt,
  isPaid,
}: {
  action: Action;
  shareId: string;
  redirectTo: string;
  hasReceipt: boolean;
  isPaid: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (isPaid) {
    return (
      <form action={action}>
        <input type="hidden" name="share_id" value={shareId} />
        <input type="hidden" name="status" value="pending" />
        <input type="hidden" name="redirect_to" value={redirectTo} />
        <SubmitButton className="button ghost small" pendingLabel="Desfazendo...">
          Desfazer
        </SubmitButton>
      </form>
    );
  }

  if (hasReceipt) {
    return (
      <form action={action}>
        <input type="hidden" name="share_id" value={shareId} />
        <input type="hidden" name="status" value="paid" />
        <input type="hidden" name="redirect_to" value={redirectTo} />
        <SubmitButton className="button ghost small" pendingLabel="Salvando...">
          Marcar pago
        </SubmitButton>
      </form>
    );
  }

  return (
    <>
      <button type="button" className="button ghost small" onClick={() => setOpen(true)}>
        Marcar pago
      </button>
      {open && (
        <div className="modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-no-receipt-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-icon">!</div>
            <div>
              <h3 id="confirm-no-receipt-title">Marcar como paga sem comprovante?</h3>
              <p>
                Nenhum comprovante foi anexado a esta parcela ainda. Você
                pode marcar como paga mesmo assim, ou fechar e pedir para
                anexar o comprovante primeiro.
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" className="button ghost" onClick={() => setOpen(false)}>
                Cancelar
              </button>
              <form action={action}>
                <input type="hidden" name="share_id" value={shareId} />
                <input type="hidden" name="status" value="paid" />
                <input type="hidden" name="redirect_to" value={redirectTo} />
                <SubmitButton className="button primary" pendingLabel="Salvando...">
                  Marcar mesmo assim
                </SubmitButton>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
