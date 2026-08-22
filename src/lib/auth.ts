import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type PermissionKey =
  | "manage_expenses"
  | "mark_expenses_paid"
  | "view_wallet_balance"
  | "manage_tasks"
  | "manage_shopping"
  | "manage_members";

export type AppProfile = {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "viewer";
  status: "pending" | "active";
  household_id: string | null;
  member_id: string | null;
  permissions: Partial<Record<PermissionKey, boolean>>;
};

export function can(profile: AppProfile, perm: PermissionKey): boolean {
  // A lista e os lançamentos de compras são administrados exclusivamente
  // pelo administrador. A chave permanece no tipo apenas para compatibilidade
  // com perfis criados antes dessa regra.
  if (perm === "manage_shopping") return profile.role === "admin";
  if (profile.role === "admin") return true;
  return Boolean(profile.permissions?.[perm]);
}

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
    .select("id, full_name, email, role, status, household_id, member_id, permissions")
    .eq("id", user.id)
    .single();

  if (!profile || profile.status !== "active" || !profile.household_id) {
    redirect("/aguardando");
  }

  return {
    profile: { ...profile, permissions: profile.permissions ?? {} } as AppProfile,
    supabase,
  };
}

export async function requireAdmin() {
  const result = await requireActiveProfile();
  if (result.profile.role !== "admin") {
    throw new Error("Somente o administrador pode fazer isso.");
  }
  return result;
}

export async function requirePermission(perm: PermissionKey) {
  const result = await requireActiveProfile();
  if (!can(result.profile, perm)) {
    throw new Error("Você não tem permissão para fazer isso. Peça ao administrador para liberar o acesso em Configurações > Permissões.");
  }
  return result;
}
