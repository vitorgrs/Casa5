import { StatusPill } from "@/components/status-pill";
import { UsersIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requireActiveProfile } from "@/lib/auth";
import { linkPendingProfile, updateMemberEmail } from "./actions";

export default async function MembersPage() {
  const baseRoute = "/app/moradores";
  const { profile, supabase } = await requireActiveProfile();
  const canManageMembers = can(profile, "manage_members");
  const [{ data: members }, { data: profiles }] = await Promise.all([
    supabase
      .from("household_members")
      .select("id,name,email,pix_key,initials,color_key,is_admin,display_order,active")
      .eq("household_id", profile.household_id)
      .order("display_order"),
    supabase
      .from("profiles")
      .select("id,full_name,email,role,status,member_id,created_at")
      .order("created_at"),
  ]);
  const pending = (profiles ?? []).filter((item) => item.status === "pending");

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Acessos e divisão</span>
          <h1>Moradores</h1>
          <p>
            Todos podem visualizar moradores e chaves PIX. Edição de dados e
            liberação de acesso dependem das permissões definidas pelo
            administrador.
          </p>
        </div>
        <div className="role-chip">
          <UsersIcon /> 5 moradores
        </div>
      </div>

      <div className="member-grid">
        {(members ?? []).map((member) => {
          const linked = (profiles ?? []).find(
            (item) => item.member_id === member.id,
          );
          return (
            <article className="card member-card" key={member.id}>
              <div className={`avatar avatar-${member.color_key}`}>
                {member.initials}
              </div>
              <h3>{member.name}</h3>
              <p>{member.email ?? "E-mail ainda não definido"}</p>
              <StatusPill status={member.is_admin ? "admin" : "viewer"} />
              <div>
                <StatusPill
                  status={linked?.status === "active" ? "active" : "pending"}
                />
              </div>
              <div className="pix-display">
                <span className="muted-text" style={{ fontSize: 10 }}>Chave PIX</span>
                <strong>{member.pix_key ?? "Não cadastrada"}</strong>
              </div>
              {canManageMembers && (
                <form
                  action={updateMemberEmail}
                  className="stack-form"
                  style={{ marginTop: 15 }}
                >
                  <input type="hidden" name="member_id" value={member.id} />
                  <input type="hidden" name="redirect_to" value={baseRoute} />
                  <label>
                    E-mail de acesso
                    <input
                      name="email"
                      type="email"
                      defaultValue={member.email ?? ""}
                      placeholder="morador@email.com"
                    />
                  </label>
                  <label>
                    Chave PIX
                    <input
                      name="pix_key"
                      defaultValue={member.pix_key ?? ""}
                      placeholder="CPF, e-mail, telefone ou chave aleatória"
                    />
                  </label>
                  <SubmitButton className="button secondary small" pendingLabel="Salvando...">
                    Salvar dados
                  </SubmitButton>
                </form>
              )}
            </article>
          );
        })}
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <h2>Solicitações pendentes</h2>
            <span className="muted-text" style={{ fontSize: 10 }}>
              Associe uma conta criada a um dos moradores disponíveis.
            </span>
          </div>
          <StatusPill status="pending" />
        </div>
        <div className="card-body">
          {profile.role !== "admin" ? (
            <div className="empty">
              Somente o Vitor pode liberar novos acessos.
            </div>
          ) : (
            <div className="pending-list">
              {pending.map((item) => (
                <form
                  action={linkPendingProfile}
                  className="pending-row"
                  key={item.id}
                >
                  <input
                    type="hidden"
                    name="profile_email"
                    value={item.email}
                  />
                  <input type="hidden" name="redirect_to" value={baseRoute} />
                  <label className="field">
                    Conta solicitante
                    <input
                      value={`${item.full_name} — ${item.email}`}
                      readOnly
                    />
                  </label>
                  <label className="field">
                    Associar ao morador
                    <select name="member_id" required defaultValue="">
                      <option value="" disabled>
                        Selecione
                      </option>
                      {(members ?? []).map((member) => (
                        <option value={member.id} key={member.id}>
                          {member.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <SubmitButton pendingLabel="Liberando...">Liberar acesso</SubmitButton>
                </form>
              ))}
              {pending.length === 0 && (
                <div className="empty">
                  Nenhuma solicitação aguardando liberação.
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="card pad" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Como funciona a permissão</h3>
        <p className="note">
          O banco utiliza políticas de segurança por linha (RLS). Usuários
          ativos sempre conseguem consultar os dados da casa; inclusões,
          alterações e exclusões dependem da função de administrador ou da
          permissão específica liberada em Configurações {"->"} Permissões dos
          moradores.
        </p>
      </section>
    </>
  );
}
