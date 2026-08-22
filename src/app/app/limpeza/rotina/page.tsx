import Link from "next/link";
import { ArrowIcon, SettingsIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { requireAdmin } from "@/lib/auth";
import { addDays, formatHouseDate, todayIso } from "@/lib/chore-rotation";
import { reviewDaySwap } from "../actions";
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
  const { profile, supabase } = await requireAdmin();

  const [
    { data: settings },
    { data: members },
    { data: rotationRows },
    { data: swaps },
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

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Administração • Casa em dia</span>
          <h1>Configurar escala diária</h1>
          <p>Defina a ordem dos moradores e aprove ou recuse pedidos de troca.</p>
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
