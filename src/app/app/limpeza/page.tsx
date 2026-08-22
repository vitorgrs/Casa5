import Link from "next/link";
import { CalendarIcon, CheckIcon, PlusIcon, SettingsIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requireActiveProfile } from "@/lib/auth";
import {
  addDays,
  dateIsInActiveSwap,
  formatHouseDate,
  isIsoDate,
  rotationMemberForDate,
  STANDARD_DAILY_TASKS,
  todayIso,
  type RotationMember,
  type RotationSwap,
} from "@/lib/chore-rotation";
import { deleteTask } from "../organizacao/actions";
import {
  recordDailyExtraTask,
  requestDaySwap,
  toggleDailyTaskCompletion,
} from "./actions";

export const dynamic = "force-dynamic";

function validMonth(value?: string) {
  if (value && /^\d{4}-\d{2}$/.test(value)) return value;
  return todayIso().slice(0, 7);
}

function shiftMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

const weekdayShort = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const monthNames = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

export default async function ChoresPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    day?: string;
    success?: string;
    error?: string;
    updated?: string;
  }>;
}) {
  const params = await searchParams;
  const month = validMonth(params.month);
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(`${month}-01T00:00:00.000Z`).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${pad(daysInMonth)}`;
  const selectedDay =
    isIsoDate(params.day) && params.day.startsWith(`${month}-`) ? params.day : null;
  const today = todayIso();
  const baseRoute = `/app/limpeza?month=${month}`;
  const { profile, supabase } = await requireActiveProfile();
  const canManageTasks = can(profile, "manage_tasks");

  const [
    { data: settings },
    { data: members },
    { data: rotationRows },
    { data: swaps },
    { data: completions },
    { data: calendarTasks },
  ] = await Promise.all([
    supabase
      .from("daily_rotation_settings")
      .select("start_date")
      .eq("household_id", profile.household_id)
      .maybeSingle(),
    supabase
      .from("household_members")
      .select("id,name,initials,color_key,display_order")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
    supabase
      .from("daily_rotation_members")
      .select("member_id,rotation_order")
      .eq("household_id", profile.household_id)
      .order("rotation_order"),
    supabase
      .from("chore_day_swap_requests")
      .select(
        "id,requester_member_id,requester_date,target_member_id,target_date,status,created_at,review_note",
      )
      .eq("household_id", profile.household_id)
      .order("created_at", { ascending: false }),
    supabase
      .from("daily_chore_completions")
      .select("id,reference_date,task_key,completed_at,completed_by_member_id")
      .eq("household_id", profile.household_id)
      .gte("reference_date", monthStart)
      .lte("reference_date", monthEnd),
    supabase
      .from("tasks")
      .select(
        "id,title,description,due_date,task_assignees(id,done,member:household_members(id,name,initials,color_key))",
      )
      .eq("household_id", profile.household_id)
      .eq("scope", "casa")
      .gte("due_date", monthStart)
      .lte("due_date", monthEnd)
      .order("due_date"),
  ]);

  const orderByMember = new Map(
    (rotationRows ?? []).map((row) => [row.member_id, row.rotation_order]),
  );
  const rotationMembers: RotationMember[] = (members ?? [])
    .map((member) => ({
      id: member.id,
      name: member.name,
      initials: member.initials,
      color_key: member.color_key,
      rotation_order: orderByMember.get(member.id) ?? member.display_order,
    }))
    .sort((first, second) => first.rotation_order - second.rotation_order);
  const rotationSwaps = (swaps ?? []) as RotationSwap[];
  const completedKeys = new Set(
    (completions ?? []).map(
      (completion) => `${completion.reference_date}:${completion.task_key}`,
    ),
  );
  const tasksByDay = new Map<string, NonNullable<typeof calendarTasks>>();
  for (const task of calendarTasks ?? []) {
    if (!task.due_date) continue;
    const current = tasksByDay.get(task.due_date) ?? [];
    current.push(task);
    tasksByDay.set(task.due_date, current);
  }

  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const selectedOwner = selectedDay
    ? rotationMemberForDate(
        selectedDay,
        settings?.start_date ?? null,
        rotationMembers,
        rotationSwaps,
      )
    : null;
  const selectedTasks = selectedDay ? tasksByDay.get(selectedDay) ?? [] : [];
  const selectedSwap = selectedDay
    ? (swaps ?? []).find(
        (swap) =>
          swap.status !== "rejected" &&
          (swap.requester_date === selectedDay || swap.target_date === selectedDay),
      )
    : null;
  const canUpdateSelectedDay = Boolean(
    selectedDay &&
      selectedOwner &&
      selectedDay <= today &&
      (profile.role === "admin" || profile.member_id === selectedOwner.id),
  );
  const canRequestSelectedDaySwap = Boolean(
    selectedDay &&
      selectedOwner &&
      selectedDay > today &&
      profile.member_id === selectedOwner.id &&
      !dateIsInActiveSwap(selectedDay, rotationSwaps),
  );
  const swapTargetDates = canRequestSelectedDaySwap
    ? Array.from({ length: 120 }, (_, index) => addDays(selectedDay!, index + 1))
        .filter((date) => !dateIsInActiveSwap(date, rotationSwaps))
        .map((date) => ({
          date,
          member: rotationMemberForDate(
            date,
            settings?.start_date ?? null,
            rotationMembers,
            rotationSwaps,
          ),
        }))
        .filter(
          (option): option is { date: string; member: RotationMember } =>
            Boolean(option.member && option.member.id !== profile.member_id),
        )
    : [];

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Casa em dia</span>
          <h1>Escala diária da casa</h1>
          <p>
            Um morador por dia cuida das tarefas padrão. Clique em uma data
            para ver a lista, registrar o que foi feito ou solicitar uma troca.
          </p>
        </div>
        {profile.role === "admin" && (
          <div className="page-actions">
            <Link className="button secondary" href="/app/limpeza/rotina">
              <SettingsIcon /> Administrar escala
            </Link>
          </div>
        )}
      </div>

      {params.success && <div className="message success">{params.success}</div>}
      {params.error && <div className="message error">{params.error}</div>}

      <section className="card pad rotation-calendar-card">
        <div className="month-nav rotation-month-nav">
          <Link href={`/app/limpeza?month=${shiftMonth(month, -1)}`} aria-label="Mês anterior">
            ‹
          </Link>
          <div>
            <CalendarIcon />
            <strong>{monthNames[monthNumber - 1]} de {year}</strong>
          </div>
          <Link href={`/app/limpeza?month=${shiftMonth(month, 1)}`} aria-label="Próximo mês">
            ›
          </Link>
        </div>

        <div className="calendar-grid rotation-calendar-grid">
          {weekdayShort.map((weekday) => (
            <div key={weekday} className="calendar-weekday">{weekday}</div>
          ))}
          {cells.map((day, index) => {
            if (day === null) {
              return <div key={`empty-${index}`} className="calendar-cell empty" />;
            }
            const iso = `${month}-${pad(day)}`;
            const owner = rotationMemberForDate(
              iso,
              settings?.start_date ?? null,
              rotationMembers,
              rotationSwaps,
            );
            const completedCount = STANDARD_DAILY_TASKS.filter((task) =>
              completedKeys.has(`${iso}:${task.key}`),
            ).length;
            const extraCount = tasksByDay.get(iso)?.length ?? 0;
            const isToday = iso === today;
            const isSelected = iso === selectedDay;
            const isSwapped = rotationSwaps.some(
              (swap) =>
                swap.status === "approved" &&
                (swap.requester_date === iso || swap.target_date === iso),
            );

            return (
              <Link
                key={iso}
                href={`/app/limpeza?month=${month}&day=${iso}`}
                className={`calendar-cell rotation-calendar-cell ${isToday ? "today" : ""} ${isSelected ? "selected" : ""} ${!owner ? "rotation-not-started" : ""}`}
              >
                <span className="rotation-day-top">
                  <span className="calendar-day-number">{day}</span>
                  {isSwapped && <span className="rotation-swap-badge" title="Dia trocado">⇄</span>}
                </span>
                {owner ? (
                  <>
                    <span className="rotation-owner">
                      <span className={`avatar avatar-${owner.color_key}`}>{owner.initials}</span>
                      <strong>{owner.name.split(" ")[0]}</strong>
                    </span>
                    <span className="rotation-progress">
                      {completedCount}/{STANDARD_DAILY_TASKS.length} tarefas
                      {extraCount > 0 ? ` • +${extraCount}` : ""}
                    </span>
                  </>
                ) : (
                  <span className="rotation-awaiting">Sem escala</span>
                )}
              </Link>
            );
          })}
        </div>
      </section>

      {selectedDay && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card modal-card-lg daily-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="day-modal-title"
          >
            <div className="card-head daily-modal-head">
              <div>
                <span className="eyebrow">Rotina do dia</span>
                <h3 id="day-modal-title">
                  {formatHouseDate(selectedDay, {
                    weekday: "long",
                    day: "2-digit",
                    month: "long",
                    year: "numeric",
                  })}
                </h3>
              </div>
              <Link className="button ghost small" href={baseRoute}>Fechar</Link>
            </div>

            {selectedOwner ? (
              <div className="daily-owner-banner">
                <div className={`avatar avatar-${selectedOwner.color_key}`}>
                  {selectedOwner.initials}
                </div>
                <div>
                  <span>Responsável do dia</span>
                  <strong>{selectedOwner.name}</strong>
                </div>
                {selectedSwap?.status === "approved" && (
                  <span className="status-pill success">Troca aprovada</span>
                )}
                {selectedSwap?.status === "pending" && (
                  <span className="status-pill warning">Troca aguardando aprovação</span>
                )}
              </div>
            ) : (
              <div className="message info">
                A escala começa em {settings?.start_date ? formatHouseDate(settings.start_date) : "uma data ainda não configurada"}.
              </div>
            )}

            {selectedOwner && (
              <>
                <section className="daily-modal-section">
                  <div className="daily-section-title">
                    <div>
                      <h4>Tarefas padrão</h4>
                      <p>Estas tarefas aparecem automaticamente em todos os dias da escala.</p>
                    </div>
                    <span className="daily-completion-count">
                      {STANDARD_DAILY_TASKS.filter((task) =>
                        completedKeys.has(`${selectedDay}:${task.key}`),
                      ).length}/{STANDARD_DAILY_TASKS.length}
                    </span>
                  </div>

                  <div className="daily-task-list">
                    {STANDARD_DAILY_TASKS.map((task) => {
                      const completed = completedKeys.has(`${selectedDay}:${task.key}`);
                      return (
                        <form action={toggleDailyTaskCompletion} key={task.key}>
                          <input type="hidden" name="reference_date" value={selectedDay} />
                          <input type="hidden" name="task_key" value={task.key} />
                          <input type="hidden" name="completed" value={completed ? "0" : "1"} />
                          <input
                            type="hidden"
                            name="redirect_to"
                            value={`/app/limpeza?month=${month}&day=${selectedDay}`}
                          />
                          <button
                            type="submit"
                            className={`daily-task-row ${completed ? "completed" : ""}`}
                            disabled={!canUpdateSelectedDay}
                            title={
                              selectedDay > today
                                ? "A tarefa poderá ser marcada no próprio dia."
                                : !canUpdateSelectedDay
                                  ? "Somente o responsável do dia ou o administrador pode alterar."
                                  : undefined
                            }
                          >
                            <span className="daily-task-check"><CheckIcon /></span>
                            <span>{task.label}</span>
                            <small>{completed ? "Concluída" : "Pendente"}</small>
                          </button>
                        </form>
                      );
                    })}
                  </div>
                  {selectedDay > today && (
                    <p className="note">As tarefas poderão ser marcadas como concluídas no próprio dia.</p>
                  )}
                </section>

                <section className="daily-modal-section">
                  <div className="daily-section-title">
                    <div>
                      <h4>Outras tarefas realizadas</h4>
                      <p>Registre algo a mais que o responsável fez nesse dia.</p>
                    </div>
                  </div>

                  <div className="daily-extra-list">
                    {selectedTasks.map((task) => (
                      <div className="daily-extra-row" key={task.id}>
                        <span className="daily-task-check completed"><CheckIcon /></span>
                        <div>
                          <strong>{task.title}</strong>
                          <small>{task.description ?? "Tarefa extra concluída."}</small>
                        </div>
                        {canManageTasks && (
                          <form action={deleteTask}>
                            <input type="hidden" name="task_id" value={task.id} />
                            <input
                              type="hidden"
                              name="redirect_to"
                              value={`/app/limpeza?month=${month}&day=${selectedDay}`}
                            />
                            <button className="button danger small" type="submit">Excluir</button>
                          </form>
                        )}
                      </div>
                    ))}
                    {selectedTasks.length === 0 && (
                      <div className="empty">Nenhuma tarefa extra registrada.</div>
                    )}
                  </div>

                  {canUpdateSelectedDay && (
                    <form action={recordDailyExtraTask} className="stack-form daily-extra-form">
                      <input type="hidden" name="reference_date" value={selectedDay} />
                      <input
                        type="hidden"
                        name="redirect_to"
                        value={`/app/limpeza?month=${month}&day=${selectedDay}`}
                      />
                      <label>
                        O que mais foi feito?
                        <input name="title" required placeholder="Ex.: Organizei a despensa" />
                      </label>
                      <label>
                        Observação (opcional)
                        <input name="description" placeholder="Detalhes da tarefa" />
                      </label>
                      <SubmitButton className="button secondary" pendingLabel="Registrando...">
                        <PlusIcon /> Registrar tarefa extra
                      </SubmitButton>
                    </form>
                  )}
                </section>

                {canRequestSelectedDaySwap && (
                  <section className="daily-modal-section swap-request-section">
                    <div className="daily-section-title">
                      <div>
                        <h4>Precisa trocar este dia?</h4>
                        <p>Escolha o dia de outro morador. A mudança só entra no calendário após aprovação do administrador.</p>
                      </div>
                    </div>
                    {swapTargetDates.length > 0 ? (
                      <form action={requestDaySwap} className="stack-form">
                        <input type="hidden" name="requester_date" value={selectedDay} />
                        <input
                          type="hidden"
                          name="redirect_to"
                          value={`/app/limpeza?month=${month}&day=${selectedDay}`}
                        />
                        <label>
                          Trocar com qual dia?
                          <select name="target_date" required defaultValue="">
                            <option value="" disabled>Selecione uma data e um morador</option>
                            {swapTargetDates.map((option) => (
                              <option value={option.date} key={option.date}>
                                {formatHouseDate(option.date, {
                                  weekday: "short",
                                  day: "2-digit",
                                  month: "2-digit",
                                  year: "numeric",
                                })} — {option.member.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <SubmitButton pendingLabel="Enviando...">Solicitar troca</SubmitButton>
                      </form>
                    ) : (
                      <div className="empty">Nenhum outro dia disponível para troca nos próximos 120 dias.</div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
