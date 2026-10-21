import Link from "next/link";
import { ArrowIcon, SettingsIcon } from "@/components/icons";
import { requireAdmin } from "@/lib/auth";
import {
  isPageKey,
  isPermissionKey,
  PAGE_KEYS,
  PERMISSION_KEYS,
} from "@/lib/permissions";
import { AccessEditor } from "./access-editor";

export default async function PermissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const params = await searchParams;
  const { profile, supabase } = await requireAdmin();

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("*, member:household_members(name,initials,color_key)")
    .eq("household_id", profile.household_id)
    .eq("status", "active")
    .order("full_name");

  const nonAdmins = (profiles ?? []).filter((item) => item.role !== "admin");

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Configurações</span>
          <h1>Acesso dos moradores</h1>
          <p>
            Defina, para cada morador, o que pode fazer e quais páginas pode
            ver. As regras valem também no banco de dados. O administrador
            sempre tem acesso total, e somente ele altera esta tela.
          </p>
        </div>
        <Link className="button ghost small" href="/app/configuracoes">
          <ArrowIcon /> Voltar
        </Link>
      </div>

      {params.success && <div className="message success">{params.success}</div>}
      {params.error && <div className="message error">{params.error}</div>}
      {error && (
        <div className="message error">
          Não foi possível carregar os moradores: {error.message}
        </div>
      )}

      {nonAdmins.length === 0 && !error && (
        <div className="card pad">
          <div className="empty">
            Nenhum morador com acesso ativo além do administrador ainda.
          </div>
        </div>
      )}

      <div className="grid" style={{ gap: 16 }}>
        {nonAdmins.map((item) => {
          const member = Array.isArray(item.member) ? item.member[0] : item.member;
          const permissions = (item.permissions ?? {}) as Record<string, unknown>;
          const granted = Object.entries(permissions)
            .filter(([key, value]) => value === true && isPermissionKey(key))
            .map(([key]) => key)
            .filter(isPermissionKey);
          const hiddenPages = ((item.hidden_pages ?? []) as string[]).filter(isPageKey);
          const firstName = String(item.full_name ?? "").split(" ")[0] || "morador";
          return (
            <details
              className="card access-card"
              id={`perfil-${item.id}`}
              key={item.id}
            >
              <summary className="access-card-summary">
                <div className={`avatar avatar-${member?.color_key ?? "violet"}`}>
                  {member?.initials ?? String(item.full_name ?? "?").slice(0, 1)}
                </div>
                <div className="access-card-title">
                  <strong>{item.full_name}</strong>
                  <small>{item.email}</small>
                </div>
                <span className="status-pill info">
                  {granted.length}/{PERMISSION_KEYS.length} funções
                </span>
                <span className={`status-pill ${hiddenPages.length ? "warning" : "success"}`}>
                  {PAGE_KEYS.length - hiddenPages.length}/{PAGE_KEYS.length} páginas
                </span>
                <SettingsIcon />
              </summary>
              <div className="access-card-body">
                <AccessEditor
                  profileId={item.id}
                  firstName={firstName}
                  initialPermissions={granted}
                  initialHiddenPages={hiddenPages}
                />
              </div>
            </details>
          );
        })}
      </div>
    </>
  );
}
