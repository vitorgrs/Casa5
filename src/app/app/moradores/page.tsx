import { StatusPill } from "@/components/status-pill";
import { UsersIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import { linkPendingProfile, updateMemberEmail } from "./actions";

export default async function MembersPage() {
  const { profile, supabase } = await requireActiveProfile();
  const [{ data: members }, { data: profiles }] = await Promise.all([
    supabase.from("household_members").select("id,name,email,initials,color_key,is_admin,display_order,active").eq("household_id", profile.household_id).order("display_order"),
    supabase.from("profiles").select("id,full_name,email,role,status,member_id,created_at").order("created_at")
  ]);
  const pending = (profiles ?? []).filter((item) => item.status === "pending");

  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">Acessos e divisão</span><h1>Moradores</h1><p>Os cinco podem visualizar o sistema. Apenas o Vitor possui permissão de alteração.</p></div>
        <div className="role-chip"><UsersIcon/> 5 moradores</div>
      </div>

      <div className="member-grid">
        {(members ?? []).map((member) => {
          const linked = (profiles ?? []).find((item) => item.member_id === member.id);
          return (
            <article className="card member-card" key={member.id}>
              <div className={`avatar avatar-${member.color_key}`}>{member.initials}</div>
              <h3>{member.name}</h3>
              <p>{member.email ?? "E-mail ainda não definido"}</p>
              <StatusPill status={member.is_admin ? "admin" : "viewer"}/>
              <div><StatusPill status={linked?.status === "active" ? "active" : "pending"}/></div>
              {profile.role === "admin" && (
                <form action={updateMemberEmail} className="stack-form" style={{ marginTop: 15 }}>
                  <input type="hidden" name="member_id" value={member.id}/>
                  <label>E-mail de acesso<input name="email" type="email" defaultValue={member.email ?? ""} placeholder="morador@email.com"/></label>
                  <button className="button secondary small" type="submit">Salvar e-mail</button>
                </form>
              )}
            </article>
          );
        })}
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h2>Solicitações pendentes</h2><span className="muted-text" style={{fontSize:10}}>Associe uma conta criada a um dos moradores disponíveis.</span></div><StatusPill status="pending"/></div>
        <div className="card-body">
          {profile.role !== "admin" ? <div className="empty">Somente o Vitor pode liberar novos acessos.</div> : (
            <div className="pending-list">
              {pending.map((item) => (
                <form action={linkPendingProfile} className="pending-row" key={item.id}>
                  <input type="hidden" name="profile_email" value={item.email}/>
                  <label className="field">Conta solicitante<input value={`${item.full_name} — ${item.email}`} readOnly/></label>
                  <label className="field">Associar ao morador<select name="member_id" required defaultValue=""><option value="" disabled>Selecione</option>{(members ?? []).map((member)=><option value={member.id} key={member.id}>{member.name}</option>)}</select></label>
                  <button className="button primary" type="submit">Liberar acesso</button>
                </form>
              ))}
              {pending.length === 0 && <div className="empty">Nenhuma solicitação aguardando liberação.</div>}
            </div>
          )}
        </div>
      </section>

      <section className="card pad" style={{ marginTop: 16 }}>
        <h3 style={{marginTop:0}}>Como funciona a permissão</h3>
        <p className="note">O banco utiliza políticas de segurança por linha. Usuários ativos conseguem apenas consultar os dados da Casa Cinco; inclusões, alterações e exclusões são aceitas somente quando o perfil autenticado possui a função de administrador.</p>
      </section>
    </>
  );
}
