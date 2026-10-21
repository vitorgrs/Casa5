import { NextResponse } from "next/server";
import { can, requireActiveProfile } from "@/lib/auth";
import { signedReceiptUrl } from "@/lib/storage";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ shareId: string }> },
) {
  const { shareId } = await params;
  const { profile, supabase } = await requireActiveProfile();
  const { data: share, error } = await supabase
    .from("shopping_purchase_shares")
    .select("member_id,receipt_path,purchase:shopping_purchases!inner(household_id,paid_by_member_id)")
    .eq("id", shareId)
    .single();
  const purchase = Array.isArray(share?.purchase) ? share.purchase[0] : share?.purchase;
  const validReceiptPath = Boolean(
    share?.receipt_path &&
      [
        `${profile.household_id}/shopping-net/${shareId}/`,
        `${profile.household_id}/shopping-shares/${shareId}/`,
      ].some((prefix) => share.receipt_path!.startsWith(prefix)),
  );

  if (
    error ||
    !share?.receipt_path ||
    !validReceiptPath ||
    !purchase ||
    purchase.household_id !== profile.household_id ||
    (!can(profile, "manage_shopping_settlements") &&
      profile.member_id !== share.member_id &&
      profile.member_id !== purchase.paid_by_member_id)
  ) {
    return new NextResponse("Comprovante não encontrado.", { status: 404 });
  }

  const url = await signedReceiptUrl(createServiceClient(), share.receipt_path);
  if (!url) {
    return new NextResponse("Não foi possível abrir o comprovante.", { status: 502 });
  }

  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
