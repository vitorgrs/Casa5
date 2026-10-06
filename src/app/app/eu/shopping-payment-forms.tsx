"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  confirmShoppingNetPayment,
  finalizeShoppingNetReceiptUpload,
  prepareShoppingNetReceiptUpload,
  recordShoppingNetPaymentAsAdmin,
} from "@/app/app/organizacao/actions";
import { SubmitButton } from "@/components/submit-button";
import { initialFormActionState } from "@/lib/form-action-state";
import { createClient } from "@/lib/supabase/client";
import { RECEIPT_BUCKET, validateReceiptFile } from "@/lib/storage";

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
  const fileRef = useRef<HTMLInputElement>(null);
  const paymentRef = useRef<HTMLInputElement>(null);
  const [supabase] = useState(() => createClient());
  const [fileName, setFileName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setFileName(event.target.files?.[0]?.name ?? null);
    setMessage(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    const paymentAmount = paymentRef.current?.value ?? "";
    if (!file) {
      setMessage({ kind: "error", text: "Selecione um arquivo." });
      return;
    }
    const validationError = validateReceiptFile(file);
    if (validationError) {
      setMessage({ kind: "error", text: validationError });
      return;
    }

    setPending(true);
    setMessage(null);
    try {
      const preparation = await prepareShoppingNetReceiptUpload(shareId, {
        name: file.name,
        type: file.type,
        size: file.size,
      });
      if (!preparation.ok || !preparation.path || !preparation.token) {
        setMessage({ kind: "error", text: preparation.message });
        return;
      }

      const { error: uploadError } = await supabase.storage
        .from(RECEIPT_BUCKET)
        .uploadToSignedUrl(preparation.path, preparation.token, file, {
          contentType: file.type || undefined,
          upsert: false,
        });
      if (uploadError) {
        setMessage({ kind: "error", text: uploadError.message });
        return;
      }

      const result = await finalizeShoppingNetReceiptUpload(
        shareId,
        paymentAmount,
        { path: preparation.path, name: file.name || "comprovante" },
      );
      if (!result.ok) {
        setMessage({ kind: "error", text: result.message });
        return;
      }

      formRef.current?.reset();
      setFileName(null);
      setMessage({ kind: "success", text: result.message });
      router.refresh();
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Não foi possível enviar o comprovante.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="attachment-upload-form">
      <label className="field">
        Valor pago
        <input
          ref={paymentRef}
          type="number"
          name="payment_amount"
          min="0.01"
          max={max.toFixed(2)}
          step="0.01"
          defaultValue={defaultValue.toFixed(2)}
          inputMode="decimal"
          required
          disabled={pending}
        />
      </label>
      <label className="file-input-label">
        <input
          ref={fileRef}
          type="file"
          name="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
          onChange={handleChange}
          required
          disabled={pending}
        />
        <span>{fileName ?? "Escolher arquivo (PDF ou foto, até 8MB)"}</span>
      </label>
      <button className="button secondary small" type="submit" disabled={pending}>
        {pending ? (
          <>
            <span className="spinner" aria-hidden="true" /> Enviando...
          </>
        ) : (
          label
        )}
      </button>
      {message && (
        <div className={`message ${message.kind} inline-action-message`} role="status">
          {message.text}
        </div>
      )}
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

export function AdminShoppingPaymentForm({
  shareId,
  redirectTo,
  defaultValue,
  max,
}: {
  shareId: string;
  redirectTo: string;
  defaultValue: number;
  max: number;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(
    recordShoppingNetPaymentAsAdmin,
    initialFormActionState,
  );

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  return (
    <form action={formAction} className="admin-direct-payment-form">
      <input type="hidden" name="share_id" value={shareId} />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <label className="field">
        Valor que foi pago
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
      <SubmitButton className="button primary small" pendingLabel="Registrando...">
        Marcar como pago sem comprovante
      </SubmitButton>
      <small className="muted-text">
        Uso exclusivo do administrador. Se o valor for parcial, o restante continua em aberto.
      </small>
      <ActionMessage state={state} />
    </form>
  );
}
