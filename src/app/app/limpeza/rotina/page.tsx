import Link from "next/link";
import { ArrowIcon, CheckIcon, PlusIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requireActiveProfile } from "@/lib/auth";
import { checkInChore, createChore, deleteChore } from "../actions";

const weekdays = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];
const frequencies: Record<string, string> = {
  daily: "Diária",
  weekly: "Semanal",
  monthly: "Mensal",
  one_time: "Avulsa",
};

export default async function ChoreRotationPage({
  searchParams,
}: {
  searchParams: Promise<{ novo?: string }>;
}) {
  const params = await searchParams;
  const baseRoute = "/app/limpeza/rotina";
  const { profile, supabase } = await requireActiveProfile();
  const canManageChores = can(profile, "manage_chores");

  const [{ data: members }, { data: chores }] = await Promise.all([
    supabase
      .from("household_members")
      .select("id,name,initials,color_key,display_order")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
    supabase
      .from("chores")
      .select(
        "id,title,description,points,frequency,weekday,due_time,active,chore_assignments(member_id,rotation_order,member:household_members(id,name,initials,color_key))",
      )
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("created_at"),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia</span>
          <h1>Rodízio fixo</h1>
          <p>
            Tarefas recorrentes divididas entre os moradores (ex.: limpeza do
            banheiro toda semana). Para tarefas pontuais com data específica,
            use o calendário.
          </p>
        </div>
        <div className="page-actions">
          <Link className="button ghost" href="/app/limpeza">
            <ArrowIcon /> Voltar
          </Link>
          {canManageChores && (
            <Link className="button primary" href={`${baseRoute}?novo=1`}>
              <PlusIcon /> Nova tarefa fixa
            </Link>
          )}
        </div>
      </div>

      {params.novo === "1" && canManageChores && (
        <section className="card pad" style={{ marginTop: 16 }}>
          <div
            className="card-head"
            style={{ padding: 0, paddingBottom: 16, marginBottom: 18 }}
          >
            <h2>Criar tarefa fixa</h2>
            <Link href={baseRoute} className="button ghost small">
              Fechar
            </Link>
          </div>
          <form action={createChore}>
            <input type="hidden" name="redirect_to" value={baseRoute} />
            <div className="form-grid cols-3">
              <label className="field span-2">
                Nome da tarefa
                <input name="title" required placeholder="Ex.: Limpar a geladeira" />
              </label>
              <label className="field">
                Pontos
                <input name="points" type="number" min="1" defaultValue="15" required />
              </label>
              <label className="field">
                Frequência
                <select name="frequency" defaultValue="weekly">
                  <option value="daily">Diária</option>
                  <option value="weekly">Semanal</option>
                  <option value="monthly">Mensal</option>
                  <option value="one_time">Avulsa</option>
                </select>
              </label>
              <label className="field">
                Dia da semana
                <select name="weekday" defaultValue="">
                  <option value="">Não definido</option>
                  {weekdays.map((day, index) => (
                    <option value={index} key={day}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Horário sugerido
                <input name="due_time" type="time" />
              </label>
              <label className="field span-3">
                Descrição
                <textarea name="description" placeholder="O que deve ser feito para a tarefa contar como concluída?" />
              </label>
              <div className="form-section span-3">
                <h4>Quem participa do rodízio?</h4>
                <div className="member-check-grid">
                  {(members ?? []).map((member) => (
                    <label className="member-check" key={member.id}>
                      <input type="checkbox" name="member_ids" value={member.id} defaultChecked />
                      <span>{member.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="form-actions">
              <SubmitButton pendingLabel="Criando...">Criar tarefa</SubmitButton>
              <Link className="button ghost" href={baseRoute}>
                Cancelar
              </Link>
            </div>
          </form>
        </section>
      )}

      <div className="chore-grid" style={{ marginTop: 16 }}>
        {(chores ?? []).map((chore) => {
          const assignments = [...(chore.chore_assignments ?? [])].sort(
            (a, b) => a.rotation_order - b.rotation_order,
          );
          return (
            <article className="chore-card" key={chore.id}>
              <div className="chore-card-head">
                <div>
                  <h3>{chore.title}</h3>
                  <p>{chore.description ?? "Tarefa recorrente da casa."}</p>
                </div>
                <span className="points-chip">+{chore.points} pts</span>
              </div>
              <div className="assignee-list">
                {assignments.map((assignment) => {
                  const member = Array.isArray(assignment.member) ? assignment.member[0] : assignment.member;
                  return (
                    <div
                      className={`avatar avatar-${member?.color_key ?? "violet"}`}
                      title={member?.name}
                      key={assignment.member_id}
                    >
                      {member?.initials ?? "?"}
                    </div>
                  );
                })}
              </div>
              <div className="chore-foot">
                <span>
                  {frequencies[chore.frequency]}
                  {chore.weekday !== null ? ` • ${weekdays[chore.weekday]}` : ""}
                </span>
              </div>
              {canManageChores && (
                <details className="details-editor" style={{ margin: "14px -16px -16px" }}>
                  <summary>
                    <CheckIcon style={{ verticalAlign: "middle", marginRight: 6 }} /> Registrar conclusão
                  </summary>
                  <div className="editor-body">
                    <form action={checkInChore} className="stack-form" style={{ marginTop: 0 }}>
                      <input type="hidden" name="chore_id" value={chore.id} />
                      <input type="hidden" name="redirect_to" value={baseRoute} />
                      <label>
                        Morador
                        <select name="member_id" defaultValue={members?.[0]?.id}>
                          {(members ?? []).map((member) => (
                            <option value={member.id} key={member.id}>
                              {member.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Data
                        <input name="reference_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
                      </label>
                      <label>
                        Observação
                        <input name="note" placeholder="Opcional" />
                      </label>
                      <SubmitButton pendingLabel="Salvando...">Confirmar check-in</SubmitButton>
                    </form>
                    <form action={deleteChore} style={{ marginTop: 10 }}>
                      <input type="hidden" name="chore_id" value={chore.id} />
                      <input type="hidden" name="redirect_to" value={baseRoute} />
                      <SubmitButton className="button danger small" pendingLabel="Excluindo...">
                        Excluir tarefa
                      </SubmitButton>
                    </form>
                  </div>
                </details>
              )}
            </article>
          );
        })}
        {(chores ?? []).length === 0 && (
          <div className="card empty">Nenhuma tarefa fixa cadastrada ainda.</div>
        )}
      </div>
    </>
  );
}
