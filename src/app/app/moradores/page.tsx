import { StatusPill } from "@/components/status-pill";
import { AwayIcon, UsersIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requirePage } from "@/lib/auth";
import { formatHouseDate, todayIso } from "@/lib/chore-rotation";
import { currentOrUpcomingAbsence, loadMemberAbsences } from "@/lib/member-absences";
import { AbsenceControls } from "./absence-controls";
import { linkPendingProfile, updateMemberEmail } from "./actions";


export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const baseRoute = "/app/moradores";
  const { profile, supabase } = await requirePage("members");
  const canManageMembers = can(profile, "manage_members");
  const today = todayIso();
  const [{ data: members }, { data: profiles }, absences] = await Promise.all([
    supabase
      .from("household_members")
      // `*` inclui payer_identifiers quando a migration 037 já foi aplicada.
      .select("*")
      .eq("household_id", profile.household_id)
      .order("display_order"),
    supabase
      .from("profiles")
      .select("id,full_name,email,role,status,member_id,created_at")
      .order("created_at"),
    loadMemberAbsences(supabase, profile.household_id),
  ]);
  const pending = (profiles ?? []).filter((item) => item.status === "pending");
  const activeMembers = (members ?? []).filter((member) => member.active);
  const memberName = new Map((members ?? []).map((member) => [member.id, member.name]));
  const awayNow = activeMembers.filter((member) => {
    const absence = currentOrUpcomingAbsence(member.id, today, absences);
    return absence && absence.left_on <= today;
  });
  const pastAbsences = absences
    .filter((absence) => absence.returned_on !== null && absence.returned_on !== absence.left_on)
    .slice(0, 10);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Acessos e divisão</span>
          <h1>Moradores</h1>
          <p>
            Veja quem mora na casa, quem está fora e as chaves PIX.
            {canManageMembers
              ? " Marque a saída de alguém para tirar a pessoa de todos os rodízios até a volta."
              : ""}
          </p>
        </div>
        <div className="role-chip">
          <UsersIcon /> {activeMembers.length - awayNow.length} em casa
          {awayNow.length > 0 ? ` • ${awayNow.length} fora` : ""}
        </div>
      </div>

      {params.error && <div className="message error" role="alert">{params.error}</div>}

      <div className="member-grid">
        {(members ?? []).map((member) => {
          const linked = (profiles ?? []).find((item) => item.member_id === member.id);
          const absence = member.active
            ? currentOrUpcomingAbsence(member.id, today, absences)
            : null;
          const away = Boolean(absence && absence.left_on <= today);
          return (
            <article className={`card member-card ${away ? "is-away" : ""}`} key={member.id}>
              <div className="member-card-head">
                <div className={`avatar avatar-${member.color_key}`} aria-hidden="true">
                  {member.initials}
                </div>
                <div className="member-card-title">
                  <h2>{member.name}</h2>
                  <p>{member.email ?? "E-mail ainda não definido"}</p>
                </div>
              </div>

              <div className="member-card-tags">
                <StatusPill status={member.is_admin ? "admin" : "viewer"} />
                <StatusPill status={linked?.status === "active" ? "active" : "pending"} />
                {absence && (
                  <span className={`status-pill ${away ? "warning" : "info"}`}>
                    <AwayIcon aria-hidden="true" />
                    {away
                      ? `Fora desde ${formatHouseDate(absence.left_on)}`
                      : `Sai em ${formatHouseDate(absence.left_on)}`}
                  </span>
                )}
              </div>

              {absence?.note && <p className="member-card-note">{absence.note}</p>}

              <div className="pix-display">
                <span className="muted-text card-subtitle">Chave PIX</span>
                <strong>{member.pix_key ?? "Não cadastrada"}</strong>
              </div>

              {canManageMembers && member.active && (
                <AbsenceControls
                  memberId={member.id}
                  memberName={member.name}
                  today={today}
                  absence={absence ? { left_on: absence.left_on, returned_on: absence.returned_on } : null}
                />
              )}

              {canManageMembers && (
                <details className="disclosure">
                  <summary>Editar e-mail, PIX e Mercado Pago</summary>
                  <form action={updateMemberEmail} className="stack-form disclosure-body">
                    <input type="hidden" name="member_id" value={member.id} />
                    <input type="hidden" name="redirect_to" value={baseRoute} />
                    <label className="field">
                      E-mail de acesso
                      <input
                        name="email"
                        type="email"
                        autoComplete="off"
                        defaultValue={member.email ?? ""}
                        placeholder="morador@email.com"
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      Chave PIX
                      <input
                        name="pix_key"
                        defaultValue={member.pix_key ?? ""}
                        placeholder="CPF, e-mail, telefone ou chave aleatória…"
                        autoComplete="off"
                      />
                    </label>
                    <label className="field">
                      Como paga no Mercado Pago
                      <input
                        name="payer_identifiers"
                        defaultValue={(member.payer_identifiers ?? []).join(", ")}
                        placeholder="E-mails ou CPFs, separados por vírgula…"
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby={`payer-help-${member.id}`}
                      />
                      <small className="muted-text" id={`payer-help-${member.id}`}>
                        Usado só para sugerir de quem é cada Pix em Conta da casa.
                      </small>
                    </label>
                    <SubmitButton className="button secondary" pendingLabel="Salvando…">
                      Salvar dados
                    </SubmitButton>
                  </form>
                </details>
              )}
            </article>
          );
        })}
      </div>

      {pastAbsences.length > 0 && (
        <section className="card section-gap" aria-labelledby="historico-saidas">
          <div className="card-head">
            <div>
              <h2 id="historico-saidas">Histórico de saídas</h2>
              <span className="muted-text card-subtitle">
                Períodos em que alguém ficou fora dos rodízios.
              </span>
            </div>
          </div>
          <ul className="simple-list">
            {pastAbsences.map((absence) => (
              <li key={absence.id ?? `${absence.member_id}-${absence.left_on}`}>
                <strong>{memberName.get(absence.member_id) ?? "Morador"}</strong>
                <span>
                  {formatHouseDate(absence.left_on)} até {formatHouseDate(absence.returned_on!)}
                  {absence.note ? ` • ${absence.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card section-gap" aria-labelledby="solicitacoes-pendentes">
        <div className="card-head">
          <div>
            <h2 id="solicitacoes-pendentes">Solicitações pendentes</h2>
            <span className="muted-text card-subtitle">
              Associe uma conta criada a um dos moradores disponíveis.
            </span>
          </div>
          <StatusPill status="pending" />
        </div>
        <div className="card-body">
          {!canManageMembers ? (
            <div className="empty">Você não tem permissão para liberar novos acessos.</div>
          ) : (
            <div className="pending-list">
              {pending.map((item) => (
                <form action={linkPendingProfile} className="pending-row" key={item.id}>
                  <input type="hidden" name="profile_email" value={item.email} />
                  <input type="hidden" name="redirect_to" value={baseRoute} />
                  <label className="field">
                    Conta solicitante
                    <input value={`${item.full_name} — ${item.email}`} readOnly />
                  </label>
                  <label className="field">
                    Associar ao morador
                    <select name="member_id" required defaultValue="">
                      <option value="" disabled>Selecione</option>
                      {(members ?? []).map((member) => (
                        <option value={member.id} key={member.id}>{member.name}</option>
                      ))}
                    </select>
                  </label>
                  <SubmitButton pendingLabel="Liberando…">Liberar acesso</SubmitButton>
                </form>
              ))}
              {pending.length === 0 && (
                <div className="empty">Nenhuma solicitação aguardando liberação.</div>
              )}
            </div>
          )}
        </div>
      </section>

      <details className="card disclosure section-gap">
        <summary>Como funcionam as permissões</summary>
        <p className="note disclosure-body">
          O banco utiliza políticas de segurança por linha (RLS). Usuários
          ativos sempre conseguem consultar os dados da casa; inclusões,
          alterações e exclusões dependem da função de administrador ou da
          permissão específica liberada em Configurações → Permissões dos
          moradores.
        </p>
      </details>
    </>
  );
}
