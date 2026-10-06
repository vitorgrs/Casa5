import { NextResponse } from "next/server";
import { requireActiveProfile } from "@/lib/auth";
import { signedReceiptUrl } from "@/lib/storage";
import { createServiceClient } from "@/lib/supabase/service";

const attachmentKinds = ["parcela", "boleto", "comprovante-geral"] as const;
type AttachmentKind = (typeof attachmentKinds)[number];

export async function GET(
  _request: Request,
  context: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id } = await context.params;
  if (!attachmentKinds.includes(kind as AttachmentKind)) {
    return NextResponse.json({ error: "Tipo de anexo inválido." }, { status: 404 });
  }

  const { profile, supabase } = await requireActiveProfile();
  let path: string | null = null;

  if (kind === "parcela") {
    const { data: share } = await supabase
      .from("expense_shares")
      .select("receipt_path,expense:expenses(household_id)")
      .eq("id", id)
      .single();
    const expense = Array.isArray(share?.expense)
      ? share.expense[0]
      : share?.expense;
    const expectedPrefix = `${profile.household_id}/shares/${id}/`;
    if (
      expense?.household_id === profile.household_id &&
      share?.receipt_path?.startsWith(expectedPrefix)
    ) {
      path = share.receipt_path;
    }
  } else {
    const { data: expense } = await supabase
      .from("expenses")
      .select("household_id,boleto_path,payment_receipt_path")
      .eq("id", id)
      .eq("household_id", profile.household_id)
      .single();
    if (expense) {
      const candidate =
        kind === "boleto"
          ? expense.boleto_path
          : expense.payment_receipt_path;
      const expectedPrefix = `${profile.household_id}/expenses/${id}/`;
      path = candidate?.startsWith(expectedPrefix) ? candidate : null;
    }
  }

  if (!path) {
    return NextResponse.json({ error: "Anexo não encontrado." }, { status: 404 });
  }
  const url = await signedReceiptUrl(createServiceClient(), path);
  if (!url) {
    return NextResponse.json(
      { error: "Não foi possível liberar o anexo." },
      { status: 404 },
    );
  }

  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
