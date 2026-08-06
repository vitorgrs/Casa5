import Link from "next/link";
import { ArrowIcon, PlusIcon } from "@/components/icons";
import { can, requireActiveProfile } from "@/lib/auth";
import { createTask, deleteTask } from "../../organizacao/actions";

type Search = { month?: string; day?: string; nova?: string };

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

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const month = validMonth(params.month);
  const [year, monthNum] = month.split("-").map(Number);
  const todayIso = new Date().toISOString().slice(0, 10);
  const selectedDay = params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : todayIso;
  const baseRoute = `/app/limpeza/calendario?month=${month}`;

  const { profile, supabase } = await requireActiveProfile();
  const canManageTasks = can(profile, "manage_tasks");

  const firstOfMonth = new Date(year, monthNum - 1, 1);
  const firstWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const monthStartIso = `${month}-01`;
  const monthEndIso = `${year}-${pad(monthNum)}-${pad(daysInMonth)}`;

  const [{ data: members }, { data: tasks }] = await Promise.all([
    supabase
      .from("household_members")
      .select("id,name,initials,color_key")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
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

  const tasksByDay = new Map<string, typeof tasks>();
  for (const task of tasks ?? []) {
    if (!task.due_date) continue;
    if (!tasksByDay.has(task.due_date)) tasksByDay.set(task.due_date, []);
    tasksByDay.get(task.due_date)!.push(task);
  }

  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const selectedTasks = tasksByDay.get(selectedDay) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia</span>
          <h1>Calendário</h1>
          <p>Clique em um dia para ver ou cadastrar tarefas realizadas naquela data.</p>
        </div>
        <div className="page-actions">
          <Link className="button ghost small" href="/app/limpeza">
            <ArrowIcon /> Voltar para rotina
          </Link>
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 16 }}>
        <div className="month-nav" style={{ justifyContent: "center", marginBottom: 16 }}>
          <Link href={`/app/limpeza/calendario?month=${shiftMonth(month, -1)}&day=${selectedDay}`}>‹</Link>
          <strong>{monthNames[monthNum - 1]} de {year}</strong>
          <Link href={`/app/limpeza/calendario?month=${shiftMonth(month, 1)}&day=${selectedDay}`}>›</Link>
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
                href={`/app/limpeza/calendario?month=${month}&day=${iso}`}
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
      </div>

      <section className="card pad" style={{ marginTop: 16 }}>
        <div className="card-head" style={{ padding: 0, paddingBottom: 16 }}>
          <div>
            <h2>{new Date(`${selectedDay}T00:00:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}</h2>
            <span className="muted-text" style={{ fontSize: 10 }}>{selectedTasks.length} tarefa(s) registrada(s)</span>
          </div>
          {canManageTasks && (
            <Link className="button primary small" href={`/app/limpeza/calendario?month=${month}&day=${selectedDay}&nova=1`}>
              <PlusIcon /> Nova tarefa
            </Link>
          )}
        </div>

        {params.nova === "1" && canManageTasks && (
          <form action={createTask} className="stack-form" style={{ marginBottom: 20 }}>
            <input type="hidden" name="scope" value="casa" />
            <input type="hidden" name="due_date" value={selectedDay} />
            <input type="hidden" name="redirect_to" value={`${baseRoute}&day=${selectedDay}`} />
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
            <button className="button primary" type="submit">Registrar tarefa</button>
          </form>
        )}

        <div className="list">
          {selectedTasks.length === 0 && <div className="empty">Nenhuma tarefa registrada neste dia.</div>}
          {selectedTasks.map((task) => (
            <div className="list-row" key={task.id}>
              <div className="item-title">
                <strong>{task.title}</strong>
                <small>{task.description ?? ""}</small>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(task.task_assignees ?? []).map((a) => {
                  const member = Array.isArray(a.member) ? a.member[0] : a.member;
                  return (
                    <div key={a.id} className={`avatar avatar-${member?.color_key ?? "violet"}`} title={member?.name}>
                      {member?.initials ?? "?"}
                    </div>
                  );
                })}
              </div>
              {canManageTasks && (
                <form action={deleteTask}>
                  <input type="hidden" name="task_id" value={task.id} />
                  <input type="hidden" name="redirect_to" value={`${baseRoute}&day=${selectedDay}`} />
                  <button className="button danger small" type="submit">Excluir</button>
                </form>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
