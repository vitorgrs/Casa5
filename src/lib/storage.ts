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

export function validateReceiptFile(file: File) {
  if (file.size === 0) return "Selecione um arquivo.";
  if (file.size > MAX_RECEIPT_SIZE) return "O arquivo precisa ter até 8MB.";
  if (file.type && !ALLOWED_RECEIPT_TYPES.includes(file.type)) {
    return "Envie um PDF ou uma foto (JPG, PNG, WEBP ou HEIC).";
  }
  return null;
}

function slugifyFileName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "-")
    .slice(-80);
}

export async function uploadToReceiptBucket(
  supabase: SupabaseClient,
  householdId: string,
  folder: string,
  file: File,
) {
  const error = validateReceiptFile(file);
  if (error) throw new Error(error);

  const path = `${householdId}/${folder}/${Date.now()}-${slugifyFileName(file.name || "arquivo")}`;
  const { error: uploadError } = await supabase.storage
    .from(RECEIPT_BUCKET)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (uploadError) throw new Error(uploadError.message);
  return { path, name: file.name || "arquivo" };
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
