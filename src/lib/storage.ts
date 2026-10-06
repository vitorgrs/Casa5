import type { SupabaseClient } from "@supabase/supabase-js";

export const RECEIPT_BUCKET = "comprovantes";
export const MAX_RECEIPT_SIZE = 8 * 1024 * 1024; // 8MB
export const ALLOWED_RECEIPT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
];

export function validateReceiptMetadata(file: {
  size: number;
  type: string;
}) {
  if (file.size <= 0) return "Selecione um arquivo.";
  if (file.size > MAX_RECEIPT_SIZE) return "O arquivo precisa ter até 8MB.";
  if (file.type && !ALLOWED_RECEIPT_TYPES.includes(file.type)) {
    return "Envie um PDF ou uma foto (JPG, PNG, WEBP ou HEIC).";
  }
  return null;
}

export function validateReceiptFile(file: File) {
  return validateReceiptMetadata(file);
}

export function validateStoredReceiptMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  const size = Number(metadata?.size ?? metadata?.contentLength);
  if (!Number.isFinite(size) || size <= 0) {
    return "Não foi possível validar o tamanho do arquivo enviado.";
  }
  const type = String(
    metadata?.mimetype ?? metadata?.contentType ?? metadata?.content_type ?? "",
  );
  return validateReceiptMetadata({ size, type });
}

export function slugifyReceiptFileName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "-")
    .slice(-80);
}

export async function deleteFromReceiptBucket(supabase: SupabaseClient, path: string) {
  await supabase.storage.from(RECEIPT_BUCKET).remove([path]);
}

export async function signedReceiptUrl(supabase: SupabaseClient, path: string | null) {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(RECEIPT_BUCKET)
    .createSignedUrl(path, 60 * 30); // 30 minutos
  if (error) return null;
  return data.signedUrl;
}
