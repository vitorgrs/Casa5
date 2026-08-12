"use client";

import { useState, type ChangeEvent } from "react";
import { SubmitButton } from "@/components/submit-button";

type Action = (formData: FormData) => void | Promise<void>;

export function AttachmentUploadForm({
  action,
  hiddenFields,
  redirectTo,
  label,
  paymentAmount,
}: {
  action: Action;
  hiddenFields: Record<string, string>;
  redirectTo: string;
  label: string;
  paymentAmount?: {
    defaultValue: number;
    max: number;
  };
}) {
  const [fileName, setFileName] = useState<string | null>(null);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setFileName(event.target.files?.[0]?.name ?? null);
  }

  return (
    <form action={action} className="attachment-upload-form">
      {Object.entries(hiddenFields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <input type="hidden" name="redirect_to" value={redirectTo} />
      {paymentAmount && (
        <label className="field">
          Valor pago
          <input
            type="number"
            name="payment_amount"
            min="0.01"
            max={paymentAmount.max.toFixed(2)}
            step="0.01"
            defaultValue={paymentAmount.defaultValue.toFixed(2)}
            inputMode="decimal"
            required
          />
        </label>
      )}
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
    </form>
  );
}
