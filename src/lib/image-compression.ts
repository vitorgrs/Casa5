// Reduz fotos de comprovantes no navegador antes do upload. O plano gratuito
// do Supabase tem 1 GB de Storage no total; uma foto de celular de 3–5 MB cai
// para algumas centenas de KB e continua legível. PDFs nunca são alterados.

const COMPRESSIBLE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);
// Abaixo disso o ganho não compensa a recompressão (e a perda de qualidade).
const MIN_SIZE_TO_COMPRESS = 600 * 1024;
// Lado maior suficiente para ler valores, datas e códigos de um comprovante.
const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 0.82;

function jpegName(name: string) {
  const base = name.replace(/\.[^./\\]+$/, "") || "comprovante";
  return `${base}.jpg`;
}

/**
 * Devolve uma versão JPEG redimensionada da imagem ou o arquivo original
 * quando ele já é pequeno, não é imagem, o navegador não consegue decodificá-lo
 * (ex.: HEIC fora do Safari) ou a versão comprimida não ficou menor.
 */
export async function compressReceiptImage(file: File): Promise<File> {
  if (!COMPRESSIBLE_TYPES.has(file.type) || file.size < MIN_SIZE_TO_COMPRESS) {
    return file;
  }
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return file;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;

    // JPEG não tem transparência: sem o fundo branco, PNGs ficariam pretos.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], jpegName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
