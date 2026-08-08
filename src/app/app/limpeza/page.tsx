import Link from "next/link";
import {
  FireIcon,
  PlusIcon,
  SparkIcon,
  TrophyIcon,
} from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requireActiveProfile } from "@/lib/auth";
import { createTask, deleteTask } from "../organizacao/actions";

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

function validMonth(value?: string) {
  if (value && /^\d{4}-\d{2}$/.test(value)) return value;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00`);
  date.setMonth(date.getMonth() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

const weekdayShort = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const monthNames = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

export default async function ChoresPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; day?: string; nova?: string }>;
}) {
  const params = await searchParams;
  const month = validMonth(params.month);
  const [year, monthNum] = month.split("-").map(Number);
  const baseRoute = `/app/limpeza?month=${month}`;
  const { profile, supabase } = await requireActiveProfile();
  const canManageTasks = can(profile, "manage_tasks");
  const weekStart = startOfWeek();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const firstOfMonth = new Date(year, monthNum - 1, 1);
  const firstWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const monthStartIso = `${month}-01`;
  const monthEndIso = `${year}-${pad(monthNum)}-${pad(daysInMonth)}`;
  const selectedDay = params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : null;
  const todayIso = new Date().toISOString().slice(0, 10);

  const [{ data: members }, { data: logs }, { data: calendarTasks }] =
    await Promise.all([
      supabase
        .from("household_members")
        .select("id,name,initials,color_key,display_order")
        .eq("household_id", profile.household_id)
        .eq("active", true)
        .order("display_order"),
      supabase
        .from("chore_logs")
        .select(
          "id,chore_id,member_id,reference_date,completed_at,points_awarded,note,chore:chores(title),member:household_members(name,initials,color_key)",
        )
        .gte("reference_date", monthStart.toISOString().slice(0, 10))
        .order("completed_at", { ascending: false }),
      supabase
        .from("tasks")
        .select(
          "id,title,description,due_date,task_assignees(id,done,member:household_members(id,name,initials,color_key))",
        )
        .eq("household_id", profile.household_id)
        .eq("scope", "casa")
        .gte("due_date", monthStartIso)
        .lte("due_date", monthEndIso)
        .order("due_date"),
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

  const tasksByDay = new Map<string, typeof calendarTasks>();
  for (const task of calendarTasks ?? []) {
    if (!task.due_date) continue;
    if (!tasksByDay.has(task.due_date)) tasksByDay.set(task.due_date, []);
    tasksByDay.get(task.due_date)!.push(task);
  }
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const selectedTasks = selectedDay ? (tasksByDay.get(selectedDay) ?? []) : [];

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia</span>
          <h1>Rotina da casa</h1>
          <p>
            Clique em um dia do calendário para ver ou registrar as tarefas
            feitas naquela data.
          </p>
        </div>
        <div className="page-actions">
          <Link className="button ghost" href="/app/limpeza/rotina">
            Rodízio fixo
          </Link>
        </div>
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
            <span>Tarefas do mês</span>
            <span className="metric-icon">
              <SparkIcon />
            </span>
          </div>
          <strong className="metric-value">{calendarTasks?.length ?? 0}</strong>
          <span className="metric-foot">registradas no calendário</span>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="card pad">
          <div className="month-nav" style={{ justifyContent: "center", marginBottom: 16 }}>
            <Link href={`/app/limpeza?month=${shiftMonth(month, -1)}`}>‹</Link>
            <strong>{monthNames[monthNum - 1]} de {year}</strong>
            <Link href={`/app/limpeza?month=${shiftMonth(month, 1)}`}>›</Link>
          </div>
          <div className="calendar-grid">
            {weekdayShort.map((w) => (
              <div key={w} className="calendar-weekday">{w}</div>
            ))}
            {cells.map((day, index) => {
              if (day === null) return <div key={`empty-${index}`} className="calendar-cell empty" />;
              const iso = `${month}-${pad(day)}`;
              const dayTasks = tasksByDay.get(iso) ?? [];
              const isSelected = iso === selectedDay;
              const isToday = iso === todayIso;
              return (
                <Link
                  key={iso}
                  href={`/app/limpeza?month=${month}&day=${iso}`}
                  className={`calendar-cell ${isSelected ? "selected" : ""} ${isToday ? "today" : ""}`}
                >
                  <span className="calendar-day-number">{day}</span>
                  {dayTasks.length > 0 && (
                    <span className="calendar-dot-row">
                      {dayTasks.slice(0, 3).map((t) => (
                        <span key={t.id} className="calendar-dot" />
                      ))}
                    </span>
                  )}
                </Link>
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
              Histórico de conclusões e pontos do rodízio fixo.
            </span>
          </div>
        </div>
        <div className="list">
          {(logs ?? []).slice(0, 20).map((log) => {
            const member = Array.isArray(log.member) ? log.member[0] : log.member;
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
                    {new Date(`${log.reference_date}T00:00:00`).toLocaleDateString("pt-BR")}
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

      {selectedDay && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card modal-card-lg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="day-modal-title"
          >
            <div className="card-head" style={{ padding: 0, paddingBottom: 14 }}>
              <div>
                <h3 id="day-modal-title" style={{ margin: 0 }}>
                  {new Date(`${selectedDay}T00:00:00`).toLocaleDateString("pt-BR", {
                    weekday: "long",
                    day: "2-digit",
                    month: "long",
                  })}
                </h3>
                <span className="muted-text" style={{ fontSize: 11 }}>
                  {selectedTasks.length} tarefa(s) registrada(s)
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {canManageTasks && (
                  <Link
                    className="button primary small"
                    href={`/app/limpeza?month=${month}&day=${selectedDay}&nova=1`}
                  >
                    <PlusIcon /> Nova tarefa
                  </Link>
                )}
                <Link className="button ghost small" href={baseRoute}>
                  Fechar
                </Link>
              </div>
            </div>

            {params.nova === "1" && canManageTasks && (
              <form action={createTask} className="stack-form" style={{ marginBottom: 16 }}>
                <input type="hidden" name="scope" value="casa" />
                <input type="hidden" name="due_date" value={selectedDay} />
                <input
                  type="hidden"
                  name="redirect_to"
                  value={`/app/limpeza?month=${month}&day=${selectedDay}`}
                />
                <label>
                  Título da tarefa
                  <input name="title" required placeholder="Ex.: Lavar a louça" />
                </label>
                <label>
                  Descrição (opcional)
                  <input name="description" placeholder="Detalhes" />
                </label>
                <div className="form-section" style={{ padding: 0 }}>
                  <h4>Quem fez (uma ou mais pessoas)?</h4>
                  <div className="member-check-grid">
                    {(members ?? []).map((member) => (
                      <label className="member-check" key={member.id}>
                        <input type="checkbox" name="member_ids" value={member.id} />
                        <span>{member.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="form-actions">
                  <SubmitButton pendingLabel="Registrando...">Registrar tarefa</SubmitButton>
                  <Link
                    className="button ghost"
                    href={`/app/limpeza?month=${month}&day=${selectedDay}`}
                  >
                    Cancelar
                  </Link>
                </div>
              </form>
            )}

            <div className="list">
              {selectedTasks.length === 0 && (
                <div className="empty">Nenhuma tarefa registrada neste dia.</div>
              )}
              {selectedTasks.map((task) => (
                <div className="list-row" key={task.id} style={{ flexWrap: "wrap" }}>
                  <div className="item-title">
                    <strong>{task.title}</strong>
                    <small>{task.description ?? "Sem descrição."}</small>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {(task.task_assignees ?? []).length === 0 && (
                      <span className="muted-text" style={{ fontSize: 12 }}>Sem responsável definido</span>
                    )}
                    {(task.task_assignees ?? []).map((a) => {
                      const member = Array.isArray(a.member) ? a.member[0] : a.member;
                      return (
                        <div
                          key={a.id}
                          className={`avatar avatar-${member?.color_key ?? "violet"}`}
                          title={member?.name}
                        >
                          {member?.initials ?? "?"}
                        </div>
                      );
                    })}
                  </div>
                  {canManageTasks && (
                    <form action={deleteTask}>
                      <input type="hidden" name="task_id" value={task.id} />
                      <input
                        type="hidden"
                        name="redirect_to"
                        value={`/app/limpeza?month=${month}&day=${selectedDay}`}
                      />
                      <SubmitButton className="button danger small" pendingLabel="Excluindo...">
                        Excluir
                      </SubmitButton>
                    </form>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
