"use client";

import { useActionState, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import {
  confirmShoppingNetPayment,
  uploadShoppingNetReceipt,
} from "@/app/app/organizacao/actions";
import { SubmitButton } from "@/components/submit-button";
import { initialFormActionState } from "@/lib/form-action-state";

function ActionMessage({
  state,
}: {
  state: typeof initialFormActionState;
}) {
  if (state.status === "idle") return null;
  return (
    <div
      className={`message ${state.status === "error" ? "error" : "success"} inline-action-message`}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </div>
  );
}

export function ShoppingReceiptUploadForm({
  shareId,
  redirectTo,
  label,
  defaultValue,
  max,
}: {
  shareId: string;
  redirectTo: string;
  label: string;
  defaultValue: number;
  max: number;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [state, formAction] = useActionState(
    uploadShoppingNetReceipt,
    initialFormActionState,
  );

  useEffect(() => {
    if (state.status !== "success") return;
    formRef.current?.reset();
    setFileName(null);
    router.refresh();
  }, [router, state.status]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setFileName(event.target.files?.[0]?.name ?? null);
  }

  return (
    <form ref={formRef} action={formAction} className="attachment-upload-form">
      <input type="hidden" name="share_id" value={shareId} />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <label className="field">
        Valor pago
        <input
          type="number"
          name="payment_amount"
          min="0.01"
          max={max.toFixed(2)}
          step="0.01"
          defaultValue={defaultValue.toFixed(2)}
          inputMode="decimal"
          required
        />
      </label>
      <label className="file-input-label">
        <input
          type="file"
          name="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
          onChange={handleChange}
          required
        />
        <span>{fileName ?? "Escolher arquivo (PDF ou foto)"}</span>
      </label>
      <SubmitButton className="button secondary small" pendingLabel="Enviando...">
        {label}
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}

export function ShoppingPaymentConfirmationForm({
  paymentId,
  redirectTo,
  label,
}: {
  paymentId: string;
  redirectTo: string;
  label: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(
    confirmShoppingNetPayment,
    initialFormActionState,
  );

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  return (
    <form action={formAction} className="shopping-confirmation-form">
      <input type="hidden" name="payment_id" value={paymentId} />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <SubmitButton className="button secondary small" pendingLabel="Confirmando...">
        {label}
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
