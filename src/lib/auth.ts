import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AppProfile = {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "viewer";
  status: "pending" | "active";
  household_id: string | null;
  member_id: string | null;
};

export async function requireUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function requireActiveProfile(): Promise<{ profile: AppProfile; supabase: Awaited<ReturnType<typeof createClient>> }> {
  const { supabase, user } = await requireUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, status, household_id, member_id")
    .eq("id", user.id)
    .single();

  if (!profile || profile.status !== "active" || !profile.household_id) {
    redirect("/aguardando");
  }

  return { profile: profile as AppProfile, supabase };
}

export async function requireAdmin() {
  const result = await requireActiveProfile();
  if (result.profile.role !== "admin") {
    throw new Error("Somente o Vitor pode editar os dados da casa.");
  }
  return result;
}
