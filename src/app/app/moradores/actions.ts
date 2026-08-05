"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";

function destination(formData: FormData, fallback: string) {
  const value = String(formData.get("redirect_to") ?? "");
  return value.startsWith("/app") ? value : fallback;
}

function pathOf(url: string) {
  return url.split("?")[0] || "/app";
}

export async function updateMemberEmail(formData: FormData) {
  const returnTo = destination(formData, "/app/moradores");
  const { profile, supabase } = await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase() || null;
  const { error } = await supabase
    .from("household_members")
    .update({ email })
    .eq("id", String(formData.get("member_id")))
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}

export async function linkPendingProfile(formData: FormData) {
  const returnTo = destination(formData, "/app/moradores");
  const { profile, supabase } = await requireAdmin();
  const email = String(formData.get("profile_email") ?? "").trim().toLowerCase();
  const memberId = String(formData.get("member_id") ?? "");
  const { error } = await supabase
    .from("household_members")
    .update({ email })
    .eq("id", memberId)
    .eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath(pathOf(returnTo));
  redirect(returnTo);
}
