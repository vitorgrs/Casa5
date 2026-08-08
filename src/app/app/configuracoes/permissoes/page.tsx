import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { PERMISSION_CATALOG } from "@/lib/permissions";
import { ArrowIcon, SettingsIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { updatePermissions } from "../actions";

export default async function PermissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const params = await searchParams;
  const baseRoute = "/app/configuracoes/permissoes";
  const { supabase } = await requireAdmin();

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id,full_name,email,role,status,permissions,member:household_members(name,initials,color_key)")
    .eq("status", "active")
    .order("full_name");

  const nonAdmins = (profiles ?? []).filter((item) => item.role !== "admin");

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Configurações</span>
          <h1>Permissões por morador</h1>
          <p>
            Defina exatamente o que cada morador (que não é administrador)
            pode fazer no app. O administrador sempre tem acesso total.
          </p>
        </div>
        <Link className="button ghost small" href="/app/configuracoes">
          <ArrowIcon /> Voltar
        </Link>
      </div>

      {params.success && <div className="message success">{params.success}</div>}
      {params.error && <div className="message error">{params.error}</div>}

      {nonAdmins.length === 0 && (
        <div className="card pad">
          <div className="empty">
            Nenhum morador com acesso ativo além do administrador ainda.
          </div>
        </div>
      )}

      <div className="grid" style={{ gap: 16 }}>
        {nonAdmins.map((item) => {
          const member = Array.isArray(item.member) ? item.member[0] : item.member;
          const permissions = (item.permissions ?? {}) as Record<string, boolean>;
          return (
            <section className="card pad" key={item.id}>
              <div className="card-head" style={{ padding: 0, paddingBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div className={`avatar avatar-${member?.color_key ?? "violet"}`}>
                    {member?.initials ?? item.full_name.slice(0, 1)}
                  </div>
                  <div>
                    <h2 style={{ margin: 0 }}>{item.full_name}</h2>
                    <span className="muted-text" style={{ fontSize: 12 }}>{item.email}</span>
                  </div>
                </div>
                <SettingsIcon />
              </div>
              <form action={updatePermissions}>
                <input type="hidden" name="profile_id" value={item.id} />
                <input type="hidden" name="redirect_to" value={baseRoute} />
                <div className="permission-grid">
                  {PERMISSION_CATALOG.map((perm) => (
                    <label className="permission-row" key={perm.key}>
                      <input
                        type="checkbox"
                        name={`perm_${perm.key}`}
                        defaultChecked={Boolean(permissions[perm.key])}
                      />
                      <span>
                        <strong>{perm.label}</strong>
                        <small>{perm.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <SubmitButton pendingLabel="Salvando..." style={{ marginTop: 16 }}>
                  Salvar permissões de {item.full_name.split(" ")[0]}
                </SubmitButton>
              </form>
            </section>
          );
        })}
      </div>
    </>
  );
}
