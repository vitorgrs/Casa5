import { NextResponse } from "next/server";
import { can, requireActiveProfile } from "@/lib/auth";
import { signedReceiptUrl } from "@/lib/storage";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const { paymentId } = await params;
  const { profile, supabase } = await requireActiveProfile();
  const { data: payment } = await supabase
    .from("shopping_settlement_payments")
    .select(
      "id,target_share_id,debtor_member_id,creditor_member_id,receipt_path,debtor:household_members!shopping_settlement_payments_debtor_member_id_fkey(household_id)",
    )
    .eq("id", paymentId)
    .maybeSingle();
  const debtor = Array.isArray(payment?.debtor)
    ? payment.debtor[0]
    : payment?.debtor;
  const isParticipant =
    profile.member_id === payment?.debtor_member_id ||
    profile.member_id === payment?.creditor_member_id;
  const validReceiptPath = Boolean(
    payment?.receipt_path &&
      payment.target_share_id &&
      [
        `${profile.household_id}/shopping-net/${payment.target_share_id}/`,
        `${profile.household_id}/shopping-shares/${payment.target_share_id}/`,
      ].some((prefix) => payment.receipt_path!.startsWith(prefix)),
  );

  if (
    !payment?.receipt_path ||
    !validReceiptPath ||
    !debtor ||
    debtor.household_id !== profile.household_id ||
    (!can(profile, "manage_shopping_settlements") && !isParticipant)
  ) {
    return new NextResponse("Comprovante não encontrado.", { status: 404 });
  }

  const url = await signedReceiptUrl(createServiceClient(), payment.receipt_path);
  if (!url) {
    return new NextResponse("Não foi possível abrir o comprovante.", {
      status: 502,
    });
  }

  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
