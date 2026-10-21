"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  finalizeExpenseAttachmentUpload,
  prepareExpenseAttachmentUpload,
  type ExpenseAttachmentTarget,
} from "@/app/app/despesas/actions";
import { createClient } from "@/lib/supabase/client";
import { compressReceiptImage } from "@/lib/image-compression";
import { RECEIPT_BUCKET, validateReceiptFile } from "@/lib/storage";

export function AttachmentUploadForm({
  target,
  label,
}: {
  target: ExpenseAttachmentTarget;
  label: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
    const selectedFile = fileRef.current?.files?.[0];
    if (!selectedFile) {
      setMessage({ kind: "error", text: "Selecione um arquivo." });
      return;
    }

    setPending(true);
    setMessage(null);
    try {
      // Comprimir antes de validar permite aceitar fotos grandes do celular
      // que ficam dentro do limite depois de reduzidas.
      const file = await compressReceiptImage(selectedFile);
      const validationError = validateReceiptFile(file);
      if (validationError) {
        setMessage({ kind: "error", text: validationError });
        return;
      }

      const preparation = await prepareExpenseAttachmentUpload(target, {
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

      const result = await finalizeExpenseAttachmentUpload(target, {
        path: preparation.path,
        name: file.name || "arquivo",
      });
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
        text:
          error instanceof Error
            ? error.message
            : "Não foi possível enviar o arquivo.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      ref={formRef}
      className="attachment-upload-form"
      onSubmit={handleSubmit}
    >
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
        <span>{fileName ?? "Escolher arquivo (PDF até 8MB ou foto — fotos são reduzidas)"}</span>
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
        <span className={`message ${message.kind} inline-action-message`} role="status">
          {message.text}
        </span>
      )}
    </form>
  );
}
