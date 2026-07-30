"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";

export async function updateMemberEmail(formData: FormData) {
  const { profile, supabase } = await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase() || null;
  const { error } = await supabase
    .from("household_members")
    .update({ email })
    .eq("id", String(formData.get("member_id")))
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath("/app/moradores");
}

export async function linkPendingProfile(formData: FormData) {
  const { profile, supabase } = await requireAdmin();
  const email = String(formData.get("profile_email") ?? "").trim().toLowerCase();
  const memberId = String(formData.get("member_id") ?? "");
  const { error } = await supabase
    .from("household_members")
    .update({ email })
    .eq("id", memberId)
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath("/app/moradores");
}
