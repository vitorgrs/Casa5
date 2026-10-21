import Link from "next/link";
import { ArrowIcon, CheckIcon, PlusIcon, SettingsIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { requirePage } from "@/lib/auth";
import {
  addDays,
  formatHouseDate,
  todayIso,
  type StandardDailyTask,
} from "@/lib/chore-rotation";
import {
  createStandardDailyTask,
  moveStandardDailyTask,
  reviewDaySwap,
  setStandardDailyTaskActive,
  updateStandardDailyTask,
} from "../actions";
import { RotationOrderEditor } from "./rotation-order-editor";

export const dynamic = "force-dynamic";

const statusLabels: Record<string, string> = {
  pending: "Aguardando aprovação",
  approved: "Aprovada",
  rejected: "Recusada",
};

export default async function RotationAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string; updated?: string }>;
}) {
  const params = await searchParams;
  const { profile, supabase } = await requirePage("daily_rotation_admin", {
    permission: "manage_daily_rotation",
    fallback: "/app/limpeza",
  });

  const [
    { data: settings },
    { data: members },
    { data: rotationRows },
    { data: swaps },
    { data: standardTaskRows },
  ] = await Promise.all([
    supabase
      .from("daily_rotation_settings")
      .select("start_date,updated_at")
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
        "id,requester_member_id,requester_date,target_member_id,target_date,status,created_at,reviewed_at,review_note",
      )
      .eq("household_id", profile.household_id)
      .order("created_at", { ascending: false }),
    supabase
      .from("daily_standard_tasks")
      .select("id,task_key,label,description,display_order,active")
      .eq("household_id", profile.household_id)
      .order("active", { ascending: false })
      .order("display_order")
      .order("created_at"),
  ]);

  const memberMap = new Map((members ?? []).map((member) => [member.id, member]));
  const rotationOrder = new Map(
    (rotationRows ?? []).map((row) => [row.member_id, row.rotation_order]),
  );
  const orderedMembers = [...(members ?? [])].sort(
    (first, second) =>
      (rotationOrder.get(first.id) ?? first.display_order) -
      (rotationOrder.get(second.id) ?? second.display_order),
  );
  const pendingSwaps = (swaps ?? []).filter((swap) => swap.status === "pending");
  const reviewedSwaps = (swaps ?? []).filter((swap) => swap.status !== "pending");
  const defaultStartDate = settings?.start_date ?? addDays(todayIso(), 1);
  const standardTasks = (standardTaskRows ?? []) as StandardDailyTask[];
  const activeStandardTasks = standardTasks.filter((task) => task.active);
  const inactiveStandardTasks = standardTasks.filter((task) => !task.active);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Administração • Casa em dia</span>
          <h1>Configurar rotina diária</h1>
          <p>Defina a escala, controle as tarefas padrão e analise pedidos de troca.</p>
        </div>
        <div className="page-actions">
          <Link className="button ghost" href="/app/limpeza">
            <ArrowIcon /> Voltar ao calendário
          </Link>
        </div>
      </div>

      {params.success && <div className="message success">{params.success}</div>}
      {params.error && <div className="message error">{params.error}</div>}

      <div className="rotation-admin-grid">
        <section className="card pad">
          <div className="card-head rotation-admin-card-head">
            <div>
              <h2>Ordem do rodízio</h2>
              <span className="muted-text">Use as setas para definir quem vem depois de quem.</span>
            </div>
            <SettingsIcon />
          </div>
          <RotationOrderEditor
            initialMembers={orderedMembers.map((member) => ({
              id: member.id,
              name: member.name,
              initials: member.initials,
              color_key: member.color_key,
            }))}
            startDate={defaultStartDate}
          />
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Trocas pendentes</h2>
              <span className="muted-text">
                {pendingSwaps.length} solicitação(ões) aguardando análise.
              </span>
            </div>
            <span className="status-pill warning">{pendingSwaps.length}</span>
          </div>
          <div className="swap-admin-list">
            {pendingSwaps.map((swap) => {
              const requester = memberMap.get(swap.requester_member_id);
              const target = memberMap.get(swap.target_member_id);
              return (
                <article className="swap-admin-row" key={swap.id}>
                  <div className="swap-admin-person">
                    <div className={`avatar avatar-${requester?.color_key ?? "violet"}`}>
                      {requester?.initials ?? "?"}
                    </div>
                    <div>
                      <strong>{requester?.name ?? "Morador"}</strong>
                      <small>{formatHouseDate(swap.requester_date)}</small>
                    </div>
                  </div>
                  <span className="swap-arrow">⇄</span>
                  <div className="swap-admin-person">
                    <div className={`avatar avatar-${target?.color_key ?? "cyan"}`}>
                      {target?.initials ?? "?"}
                    </div>
                    <div>
                      <strong>{target?.name ?? "Morador"}</strong>
                      <small>{formatHouseDate(swap.target_date)}</small>
                    </div>
                  </div>
                  <div className="swap-review-actions">
                    <form action={reviewDaySwap}>
                      <input type="hidden" name="request_id" value={swap.id} />
                      <input type="hidden" name="decision" value="approve" />
                      <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
                      <SubmitButton className="button primary small" pendingLabel="Aprovando...">
                        Aprovar
                      </SubmitButton>
                    </form>
                    <form action={reviewDaySwap}>
                      <input type="hidden" name="request_id" value={swap.id} />
                      <input type="hidden" name="decision" value="reject" />
                      <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
                      <SubmitButton className="button danger small" pendingLabel="Recusando...">
                        Recusar
                      </SubmitButton>
                    </form>
                  </div>
                </article>
              );
            })}
            {pendingSwaps.length === 0 && (
              <div className="empty">Nenhuma troca aguardando aprovação.</div>
            )}
          </div>
        </section>
      </div>

      <section className="card pad standard-tasks-admin-card">
        <div className="card-head rotation-admin-card-head">
          <div>
            <h2>Tarefas padrão diárias</h2>
            <span className="muted-text">
              Estas tarefas aparecem automaticamente em todos os dias do calendário.
            </span>
          </div>
          <CheckIcon />
        </div>

        <form action={createStandardDailyTask} className="standard-task-create-form">
          <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
          <label>
            Nova tarefa
            <input
              name="label"
              required
              maxLength={120}
              placeholder="Ex.: Verificar o lixo da área de serviço"
            />
          </label>
          <label>
            Orientação (opcional)
            <input
              name="description"
              maxLength={500}
              placeholder="Explique rapidamente como a tarefa deve ser feita"
            />
          </label>
          <SubmitButton className="button primary" pendingLabel="Adicionando...">
            <PlusIcon /> Adicionar tarefa
          </SubmitButton>
        </form>

        <div className="standard-task-admin-list">
          {activeStandardTasks.map((task, index) => (
            <article className="standard-task-admin-row" key={task.task_key}>
              <div className="standard-task-order-actions">
                <form action={moveStandardDailyTask}>
                  <input type="hidden" name="task_key" value={task.task_key} />
                  <input type="hidden" name="direction" value="up" />
                  <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
                  <SubmitButton
                    className="icon-button"
                    pendingLabel="…"
                    disabled={index === 0}
                    aria-label={`Subir ${task.label}`}
                    title="Subir na ordem"
                  >
                    ↑
                  </SubmitButton>
                </form>
                <form action={moveStandardDailyTask}>
                  <input type="hidden" name="task_key" value={task.task_key} />
                  <input type="hidden" name="direction" value="down" />
                  <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
                  <SubmitButton
                    className="icon-button"
                    pendingLabel="…"
                    disabled={index === activeStandardTasks.length - 1}
                    aria-label={`Descer ${task.label}`}
                    title="Descer na ordem"
                  >
                    ↓
                  </SubmitButton>
                </form>
              </div>

              <form action={updateStandardDailyTask} className="standard-task-edit-form">
                <input type="hidden" name="task_key" value={task.task_key} />
                <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
                <label>
                  Nome
                  <input name="label" required maxLength={120} defaultValue={task.label} />
                </label>
                <label>
                  Orientação
                  <input
                    name="description"
                    maxLength={500}
                    defaultValue={task.description ?? ""}
                    placeholder="Opcional"
                  />
                </label>
                <SubmitButton className="button secondary small" pendingLabel="Salvando...">
                  Salvar
                </SubmitButton>
              </form>

              <form action={setStandardDailyTaskActive}>
                <input type="hidden" name="task_key" value={task.task_key} />
                <input type="hidden" name="active" value="0" />
                <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
                <SubmitButton className="button danger small" pendingLabel="Removendo...">
                  Remover
                </SubmitButton>
              </form>
            </article>
          ))}
          {activeStandardTasks.length === 0 && (
            <div className="empty">Nenhuma tarefa padrão ativa. Adicione uma acima.</div>
          )}
        </div>

        {inactiveStandardTasks.length > 0 && (
          <details className="standard-task-inactive">
            <summary>
              Tarefas removidas ({inactiveStandardTasks.length})
            </summary>
            <div className="standard-task-inactive-list">
              {inactiveStandardTasks.map((task) => (
                <div className="standard-task-inactive-row" key={task.task_key}>
                  <div>
                    <strong>{task.label}</strong>
                    <small>
                      {task.description ?? "Mantida apenas para preservar o histórico."}
                    </small>
                  </div>
                  <form action={setStandardDailyTaskActive}>
                    <input type="hidden" name="task_key" value={task.task_key} />
                    <input type="hidden" name="active" value="1" />
                    <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
                    <SubmitButton className="button ghost small" pendingLabel="Reativando...">
                      Reativar
                    </SubmitButton>
                  </form>
                </div>
              ))}
            </div>
          </details>
        )}

        <p className="note standard-task-history-note">
          Ao remover uma tarefa, ela deixa de aparecer nos próximos dias, mas o histórico já
          registrado continua preservado.
        </p>
      </section>

      {reviewedSwaps.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <div>
              <h2>Histórico de trocas</h2>
              <span className="muted-text">Últimas decisões administrativas.</span>
            </div>
          </div>
          <div className="list">
            {reviewedSwaps.slice(0, 20).map((swap) => {
              const requester = memberMap.get(swap.requester_member_id);
              const target = memberMap.get(swap.target_member_id);
              return (
                <div className="list-row" key={swap.id}>
                  <div className="item-title">
                    <strong>{requester?.name ?? "Morador"} ⇄ {target?.name ?? "Morador"}</strong>
                    <small>
                      {formatHouseDate(swap.requester_date)} e {formatHouseDate(swap.target_date)}
                      {swap.review_note ? ` • ${swap.review_note}` : ""}
                    </small>
                  </div>
                  <span className={`status-pill ${swap.status === "approved" ? "success" : "muted"}`}>
                    {statusLabels[swap.status] ?? swap.status}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
