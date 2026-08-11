"use client";

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
          Marcar como pago
        </SubmitButton>
      </form>
    );
  }

  return (
    <span style={{ display: "grid", gap: 4 }}>
      <button className="button ghost small" type="button" disabled>
        Marcar como pago
      </button>
      <small className="muted-text">Anexe o comprovante primeiro</small>
    </span>
  );
}
