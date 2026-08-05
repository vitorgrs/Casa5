import Link from "next/link";
import {
  CheckIcon,
  FireIcon,
  PlusIcon,
  SparkIcon,
  TrophyIcon,
} from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import { createChore, checkInChore, deleteChore } from "./actions";

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

function startOfWeek() {
  const date = new Date();
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function calculateStreak(dates: string[]) {
  const unique = new Set(dates);
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  while (unique.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export default async function ChoresPage({
  searchParams,
}: {
  searchParams: Promise<{ novo?: string }>;
}) {
  const params = await searchParams;
  const baseRoute = "/app/limpeza";
  const { profile, supabase } = await requireActiveProfile();
  const weekStart = startOfWeek();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [{ data: members }, { data: chores }, { data: logs }] =
    await Promise.all([
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
      supabase
        .from("chore_logs")
        .select(
          "id,chore_id,member_id,reference_date,completed_at,points_awarded,note,chore:chores(title),member:household_members(name,initials,color_key)",
        )
        .gte("reference_date", monthStart.toISOString().slice(0, 10))
        .order("completed_at", { ascending: false }),
    ]);

  const weekLogs = (logs ?? []).filter(
    (log) => new Date(`${log.reference_date}T00:00:00`) >= weekStart,
  );
  const pointMap = new Map<string, number>();
  weekLogs.forEach((log) =>
    pointMap.set(
      log.member_id,
      (pointMap.get(log.member_id) ?? 0) + log.points_awarded,
    ),
  );
  const leaderboard = (members ?? [])
    .map((member) => ({ ...member, points: pointMap.get(member.id) ?? 0 }))
    .sort((a, b) => b.points - a.points);
  const streak = calculateStreak((logs ?? []).map((log) => log.reference_date));
  const weekNumber = Math.ceil(
    ((new Date().getTime() -
      new Date(new Date().getFullYear(), 0, 1).getTime()) /
      86400000 +
      new Date(new Date().getFullYear(), 0, 1).getDay() +
      1) /
      7,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia</span>
          <h1>Rotina gamificada</h1>
          <p>
            Registre tarefas, acumule pontos e mantenha uma sequência de cuidado
            com a casa.
          </p>
        </div>
        {profile.role === "admin" && (
          <Link className="button primary" href="/app/limpeza?novo=1">
            <PlusIcon /> Nova tarefa
          </Link>
        )}
      </div>

      <div className="grid cols-3">
        <div className="card metric-card streak-card">
          <div className="metric-top">
            <span>Sequência da casa</span>
            <FireIcon />
          </div>
          <div className="streak-value">
            <FireIcon />
            <div>
              <strong>{streak}</strong>
              <small>dias consecutivos com atividade</small>
            </div>
          </div>
        </div>
        <div className="card metric-card">
          <div className="metric-top">
            <span>Pontos da semana</span>
            <span className="metric-icon">
              <TrophyIcon />
            </span>
          </div>
          <strong className="metric-value">
            {weekLogs.reduce((sum, log) => sum + log.points_awarded, 0)}
          </strong>
          <span className="metric-foot good">
            {weekLogs.length} check-ins registrados
          </span>
        </div>
        <div className="card metric-card">
          <div className="metric-top">
            <span>Tarefas ativas</span>
            <span className="metric-icon">
              <SparkIcon />
            </span>
          </div>
          <strong className="metric-value">{chores?.length ?? 0}</strong>
          <span className="metric-foot">com rodízio entre os moradores</span>
        </div>
      </div>

      {params.novo === "1" && profile.role === "admin" && (
        <section className="card pad" style={{ marginTop: 16 }}>
          <div
            className="card-head"
            style={{ padding: 0, paddingBottom: 16, marginBottom: 18 }}
          >
            <h2>Criar tarefa da casa</h2>
            <Link href={baseRoute} className="button ghost small">
              Fechar
            </Link>
          </div>
          <form action={createChore}>
            <input type="hidden" name="redirect_to" value={baseRoute} />
            <div className="form-grid cols-3">
              <label className="field span-2">
                Nome da tarefa
                <input
                  name="title"
                  required
                  placeholder="Ex.: Limpar a geladeira"
                />
              </label>
              <label className="field">
                Pontos
                <input
                  name="points"
                  type="number"
                  min="1"
                  defaultValue="15"
                  required
                />
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
                <textarea
                  name="description"
                  placeholder="O que deve ser feito para a tarefa contar como concluída?"
                />
              </label>
            </div>
            <div className="form-section">
              <h4>Participantes do rodízio</h4>
              <div className="member-check-grid">
                {(members ?? []).map((member) => (
                  <label className="member-check" key={member.id}>
                    <input
                      name="members"
                      type="checkbox"
                      value={member.id}
                      defaultChecked
                    />
                    <span>{member.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="form-actions">
              <button className="button primary" type="submit">
                Criar tarefa
              </button>
            </div>
          </form>
        </section>
      )}

      <div className="dashboard-grid">
        <section className="card pad">
          <div
            className="card-head"
            style={{ padding: 0, paddingBottom: 15, marginBottom: 15 }}
          >
            <div>
              <h2>Tarefas da casa</h2>
              <span className="muted-text" style={{ fontSize: 10 }}>
                O responsável sugerido muda automaticamente pelo número da
                semana.
              </span>
            </div>
          </div>
          <div className="chore-grid">
            {(chores ?? []).map((chore) => {
              const assignments = [...(chore.chore_assignments ?? [])].sort(
                (a, b) => a.rotation_order - b.rotation_order,
              );
              const suggested = assignments.length
                ? assignments[weekNumber % assignments.length]
                : null;
              const suggestedMember = suggested
                ? Array.isArray(suggested.member)
                  ? suggested.member[0]
                  : suggested.member
                : null;
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
                      const member = Array.isArray(assignment.member)
                        ? assignment.member[0]
                        : assignment.member;
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
                      {chore.weekday !== null
                        ? ` • ${weekdays[chore.weekday]}`
                        : ""}
                    </span>
                    <span>
                      Sugerido:{" "}
                      <strong>
                        {suggestedMember?.name?.split(" ")[0] ?? "livre"}
                      </strong>
                    </span>
                  </div>
                  {profile.role === "admin" && (
                    <details
                      className="details-editor"
                      style={{ margin: "14px -16px -16px" }}
                    >
                      <summary>
                        <CheckIcon
                          style={{ verticalAlign: "middle", marginRight: 6 }}
                        />{" "}
                        Registrar conclusão
                      </summary>
                      <div className="editor-body">
                        <form
                          action={checkInChore}
                          className="stack-form"
                          style={{ marginTop: 0 }}
                        >
                          <input
                            type="hidden"
                            name="chore_id"
                            value={chore.id}
                          />
                          <input
                            type="hidden"
                            name="redirect_to"
                            value={baseRoute}
                          />
                          <label>
                            Morador
                            <select
                              name="member_id"
                              defaultValue={
                                suggested?.member_id ?? members?.[0]?.id
                              }
                            >
                              {(members ?? []).map((member) => (
                                <option value={member.id} key={member.id}>
                                  {member.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Data
                            <input
                              name="reference_date"
                              type="date"
                              defaultValue={new Date()
                                .toISOString()
                                .slice(0, 10)}
                            />
                          </label>
                          <label>
                            Observação
                            <input name="note" placeholder="Opcional" />
                          </label>
                          <button className="button primary" type="submit">
                            Confirmar check-in
                          </button>
                        </form>
                        <form action={deleteChore} style={{ marginTop: 10 }}>
                          <input
                            type="hidden"
                            name="chore_id"
                            value={chore.id}
                          />
                          <input
                            type="hidden"
                            name="redirect_to"
                            value={baseRoute}
                          />
                          <button className="button danger small" type="submit">
                            Excluir tarefa
                          </button>
                        </form>
                      </div>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="card pad">
          <div
            className="card-head"
            style={{ padding: 0, paddingBottom: 15, marginBottom: 15 }}
          >
            <h3>Ranking semanal</h3>
            <TrophyIcon />
          </div>
          <div className="leaderboard">
            {leaderboard.map((member, index) => (
              <div className="leader-row" key={member.id}>
                <div className="leader-rank">{index + 1}</div>
                <div className="leader-person">
                  <div className={`avatar avatar-${member.color_key}`}>
                    {member.initials}
                  </div>
                  <div>
                    <strong>{member.name}</strong>
                    <small>
                      {member.points
                        ? `${weekLogs.filter((log) => log.member_id === member.id).length} atividades`
                        : "Sem atividade"}
                    </small>
                  </div>
                </div>
                <div className="leader-points">
                  <strong>{member.points}</strong>
                  <small>pontos</small>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <h2>Atividades do mês</h2>
            <span className="muted-text" style={{ fontSize: 10 }}>
              Histórico de conclusões e pontos.
            </span>
          </div>
        </div>
        <div className="list">
          {(logs ?? []).slice(0, 20).map((log) => {
            const member = Array.isArray(log.member)
              ? log.member[0]
              : log.member;
            const chore = Array.isArray(log.chore) ? log.chore[0] : log.chore;
            return (
              <div className="list-row" key={log.id}>
                <div className="item-title">
                  <strong>{chore?.title ?? "Tarefa"}</strong>
                  <small>
                    {member?.name ?? "Morador"}
                    {log.note ? ` • ${log.note}` : ""}
                  </small>
                </div>
                <div className="item-value">
                  <strong>+{log.points_awarded}</strong>
                  <small>pontos</small>
                </div>
                <div className="item-value">
                  <strong>
                    {new Date(
                      `${log.reference_date}T00:00:00`,
                    ).toLocaleDateString("pt-BR")}
                  </strong>
                  <small>data</small>
                </div>
                <span className="status-pill success">Concluída</span>
              </div>
            );
          })}
          {(logs ?? []).length === 0 && (
            <div className="empty">Nenhuma limpeza registrada ainda.</div>
          )}
        </div>
      </section>
    </>
  );
}
