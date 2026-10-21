import { redirect } from "next/navigation";
import {
  canSeePage,
  firstVisiblePage,
  hasPermission,
  type PageKey,
  type PermissionKey,
} from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type { PageKey, PermissionKey } from "@/lib/permissions";

export type AppProfile = {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "viewer";
  status: "pending" | "active";
  household_id: string | null;
  member_id: string | null;
  permissions: Partial<Record<PermissionKey, boolean>>;
  hidden_pages: PageKey[];
};

export function can(profile: AppProfile, perm: PermissionKey): boolean {
  return hasPermission(profile, perm);
}

export async function requireUser(signal?: AbortSignal) {
  const supabase = await createClient(signal);
  const { data: { user } } = await supabase.auth.getUser();
  signal?.throwIfAborted();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function requireActiveProfile(signal?: AbortSignal): Promise<{ profile: AppProfile; supabase: Awaited<ReturnType<typeof createClient>> }> {
  const { supabase, user } = await requireUser(signal);
  let profileQuery = supabase
    .from("profiles")
    // `*` mantém o login funcionando se o deploy sair antes da migration 036
    // (que cria hidden_pages); sem a coluna, todas as páginas ficam visíveis.
    .select("*")
    .eq("id", user.id);
  if (signal) profileQuery = profileQuery.abortSignal(signal);
  const { data: profile, error: profileError } = await profileQuery.single();
  signal?.throwIfAborted();
  if (profileError && profileError.code !== "PGRST116") {
    throw new Error(profileError.message);
  }

  if (!profile || profile.status !== "active" || !profile.household_id) {
    redirect("/aguardando");
  }

  return {
    profile: {
      ...profile,
      permissions: profile.permissions ?? {},
      hidden_pages: profile.hidden_pages ?? [],
    } as AppProfile,
    supabase,
  };
}

export async function requireAdmin(signal?: AbortSignal) {
  const result = await requireActiveProfile(signal);
  if (result.profile.role !== "admin") {
    throw new Error("Somente o administrador pode fazer isso.");
  }
  return result;
}

export async function requirePermission(perm: PermissionKey, signal?: AbortSignal) {
  const result = await requireActiveProfile(signal);
  if (!can(result.profile, perm)) {
    throw new Error("Você não tem permissão para fazer isso. Peça ao administrador para liberar o acesso em Configurações > Permissões.");
  }
  return result;
}

// Usada no topo de cada página. A checagem precisa ficar na página (e não no
// layout) porque o layout não é renderizado de novo na navegação pelo cliente.
export async function requirePage(
  page: PageKey,
  options: { permission?: PermissionKey; fallback?: string } = {},
) {
  const result = await requireActiveProfile();
  if (!canSeePage(result.profile, page)) {
    redirect(firstVisiblePage(result.profile) ?? "/app/sem-acesso");
  }
  // Páginas de administração exigem também a permissão correspondente.
  if (options.permission && !can(result.profile, options.permission)) {
    redirect(options.fallback ?? firstVisiblePage(result.profile) ?? "/app/sem-acesso");
  }
  return result;
}
