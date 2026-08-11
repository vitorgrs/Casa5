import Link from "next/link";
import { CartIcon, ChecklistIcon, PlusIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requireActiveProfile } from "@/lib/auth";
import { currency } from "@/lib/format";
import { signedReceiptUrl } from "@/lib/storage";
import {
  addShoppingItem,
  confirmShoppingNetPayment,
  createTask,
  deleteTask,
  removeItemFromShoppingPurchase,
  resetShoppingPurchase,
  toggleTaskAssignee,
} from "./actions";
import { ShoppingListManager } from "./shopping-purchase-form";

const purchaseScopeLabels: Record<string, string> = {
  household: "Casa toda",
  group: "Grupo",
  individual: "Individual",
};

export default async function OrganizacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ nova?: string; success?: string }>;
}) {
  const params = await searchParams;
  const baseRoute = "/app/organizacao";
  const { profile, supabase } = await requireActiveProfile();
  const canManageTasks = can(profile, "manage_tasks");
  const canManageShopping = can(profile, "manage_shopping");

  const [{ data: members }, { data: tasks }, { data: shoppingItems }, { data: purchases }] =
    await Promise.all([
      supabase
        .from("household_members")
        .select("id,name,initials,color_key,pix_key")
        .eq("household_id", profile.household_id)
        .eq("active", true)
        .order("display_order"),
      supabase
        .from("tasks")
        .select(
          "id,title,description,due_date,created_at,task_assignees(id,done,done_at,member:household_members(id,name,initials,color_key))",
        )
        .eq("household_id", profile.household_id)
        .eq("scope", "geral")
        .order("due_date", { ascending: true, nullsFirst: false }),
      supabase
        .from("shopping_items")
        .select(
          "id,name,note,category,status,quantity_planned,quantity_bought,unit_price,purchase_id,checked_at,bought_at,created_at",
        )
        .eq("household_id", profile.household_id)
        .order("created_at", { ascending: false }),
      supabase
        .from("shopping_purchases")
        .select(
          "id,purchase_scope,total_amount,bought_at,paid_by_member_id,paid_by:household_members!shopping_purchases_paid_by_member_id_fkey(id,name,pix_key),items:shopping_items(id,name,category,quantity_bought,unit_price),shopping_purchase_shares(id,member_id,amount,payment_status,paid_at,receipt_path,receipt_name,receipt_uploaded_at,member:household_members(id,name))",
        )
        .eq("household_id", profile.household_id)
        .order("bought_at", { ascending: false }),
    ]);

  const openTasks = (tasks ?? []).filter((t) =>
    (t.task_assignees ?? []).length === 0
      ? true
      : (t.task_assignees ?? []).some((a) => !a.done),
  );
  const doneTasks = (tasks ?? []).filter(
    (t) => (t.task_assignees ?? []).length > 0 && (t.task_assignees ?? []).every((a) => a.done),
  );

  const purchasesWithReceipts = await Promise.all(
    (purchases ?? []).map(async (purchase) => ({
      ...purchase,
      shopping_purchase_shares: await Promise.all(
        (purchase.shopping_purchase_shares ?? []).map(async (share) => ({
          ...share,
          receipt_url: await signedReceiptUrl(supabase, share.receipt_path),
        })),
      ),
    })),
  );

  const openShoppingItems = (shoppingItems ?? []).filter((item) => ["list", "checked"].includes(item.status));
  const legacyBought = (shoppingItems ?? []).filter((item) => item.status === "bought" && !item.purchase_id);
  const totalSpent = purchasesWithReceipts.reduce((sum, purchase) => sum + Number(purchase.total_amount), 0)
    + legacyBought.reduce((sum, item) => sum + Number(item.quantity_bought ?? 0) * Number(item.unit_price ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Organização</span>
          <h1>Pendências e lista de compras</h1>
          <p>
            Delegue o que precisa ser resolvido na casa (fora da rotina de
            limpeza) e organize as compras do mercado.
          </p>
        </div>
      </div>

      {params.success && <div className="message success">{params.success}</div>}

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <h2>Tarefas delegadas</h2>
            <span className="muted-text" style={{ fontSize: 10 }}>
              Ex.: &quot;resolver a internet até dia 9&quot; ou &quot;todos devem trocar a roupa de cama até dia 20&quot;.
            </span>
          </div>
          {canManageTasks && (
            <Link className="button primary small" href={`${baseRoute}?nova=1`}>
              <PlusIcon /> Nova tarefa
            </Link>
          )}
        </div>

        {params.nova === "1" && canManageTasks && (
          <div style={{ padding: "0 20px 20px" }}>
            <form action={createTask} className="stack-form">
              <input type="hidden" name="scope" value="geral" />
              <input type="hidden" name="redirect_to" value={baseRoute} />
              <div className="form-grid cols-3">
                <label className="field span-2">
                  Título
                  <input name="title" required placeholder="Ex.: Resolver problema da internet" />
                </label>
                <label className="field">
                  Prazo
                  <input name="due_date" type="date" />
                </label>
                <label className="field span-3">
                  Descrição (opcional)
                  <textarea name="description" placeholder="Detalhes úteis" />
                </label>
              </div>
              <div className="form-section">
                <h4>Quem é responsável?</h4>
                <div className="member-check-grid">
                  {(members ?? []).map((member) => (
                    <label className="member-check" key={member.id}>
                      <input type="checkbox" name="member_ids" value={member.id} />
                      <span>{member.name}</span>
                    </label>
                  ))}
                </div>
                <p className="note">
                  Marque todos os moradores se a tarefa é individual para cada
                  um (ex.: &quot;todos devem trocar a cama&quot;), ou apenas
                  um se for responsabilidade de uma única pessoa.
                </p>
              </div>
              <div className="form-actions">
                <SubmitButton pendingLabel="Criando...">Criar tarefa</SubmitButton>
                <Link className="button ghost" href={baseRoute}>
                  Cancelar
                </Link>
              </div>
            </form>
          </div>
        )}

        <div className="list">
          {openTasks.length === 0 && <div className="empty">Nenhuma pendência em aberto.</div>}
          {openTasks.map((task) => (
            <div className="list-row" key={task.id} style={{ flexWrap: "wrap" }}>
              <div className="item-title">
                <strong>{task.title}</strong>
                <small>{task.description ?? ""}</small>
              </div>
              <div className="item-value">
                <strong>
                  {task.due_date
                    ? new Date(`${task.due_date}T00:00:00`).toLocaleDateString("pt-BR")
                    : "sem prazo"}
                </strong>
                <small>prazo</small>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(task.task_assignees ?? []).map((a) => {
                  const member = Array.isArray(a.member) ? a.member[0] : a.member;
                  return (
                    <form action={toggleTaskAssignee} key={a.id}>
                      <input type="hidden" name="assignee_id" value={a.id} />
                      <input type="hidden" name="done" value={a.done ? "0" : "1"} />
                      <input type="hidden" name="redirect_to" value={baseRoute} />
                      <button
                        type="submit"
                        className={`button small ${a.done ? "secondary" : "ghost"}`}
                        title={a.done ? "Marcar como pendente" : "Marcar como concluída"}
                      >
                        {a.done ? "✓" : ""} {member?.name?.split(" ")[0] ?? "Morador"}
                      </button>
                    </form>
                  );
                })}
                {(task.task_assignees ?? []).length === 0 && (
                  <span className="muted-text" style={{ fontSize: 12 }}>Sem responsável definido</span>
                )}
              </div>
              {canManageTasks && (
                <form action={deleteTask}>
                  <input type="hidden" name="task_id" value={task.id} />
                  <input type="hidden" name="redirect_to" value={baseRoute} />
                  <button className="button danger small" type="submit">Excluir</button>
                </form>
              )}
            </div>
          ))}
        </div>

        {doneTasks.length > 0 && (
          <details className="details-editor" style={{ margin: "0 20px 16px" }}>
            <summary>Ver {doneTasks.length} tarefa(s) concluída(s)</summary>
            <div className="editor-body list">
              {doneTasks.map((task) => (
                <div className="list-row" key={task.id}>
                  <div className="item-title">
                    <strong>{task.title}</strong>
                  </div>
                  <span className="status-pill success">Concluída</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <h2>Lista de compras</h2>
            <span className="muted-text" style={{ fontSize: 10 }}>
              Total gasto registrado: {currency.format(totalSpent)}
            </span>
          </div>
          <CartIcon />
        </div>

        {canManageShopping && (
          <div style={{ padding: "0 20px 20px" }}>
            <form action={addShoppingItem} className="form-grid cols-3">
              <input type="hidden" name="redirect_to" value={baseRoute} />
              <label className="field">
                Item
                <input name="name" required placeholder="Ex.: Arroz" />
              </label>
              <label className="field">
                Quantidade planejada
                <input name="quantity_planned" inputMode="decimal" placeholder="Ex.: 2" />
              </label>
              <label className="field">
                Categoria
                <input name="category" placeholder="Ex.: Mercearia" />
              </label>
              <label className="field span-3">
                Observação
                <input name="note" placeholder="Opcional" />
              </label>
              <div className="form-actions span-3">
                <SubmitButton className="button secondary" pendingLabel="Adicionando...">
                  <PlusIcon /> Adicionar à lista
                </SubmitButton>
              </div>
            </form>
          </div>
        )}

        <div style={{ padding: "0 20px 8px" }}>
          <h4 style={{ margin: "8px 0" }}>
            <ChecklistIcon style={{ verticalAlign: "middle", marginRight: 6 }} />
            Checklist do mercado ({openShoppingItems.length} itens)
          </h4>
        </div>
        <ShoppingListManager
          items={openShoppingItems.map((item) => ({
            id: item.id,
            name: item.name,
            note: item.note,
            category: item.category,
            status: item.status as "list" | "checked",
            quantity_planned: item.quantity_planned,
          }))}
          members={(members ?? []).map((member) => ({ id: member.id, name: member.name }))}
          currentMemberId={profile.member_id}
          canManage={canManageShopping}
          redirectTo={baseRoute}
        />

        <div style={{ padding: "0 20px 8px" }}>
          <h4 style={{ margin: "8px 0" }}>
            Compras registradas ({purchasesWithReceipts.length + legacyBought.length})
          </h4>
        </div>
        <div className="purchase-list">
          {purchasesWithReceipts.length === 0 && legacyBought.length === 0 && (
            <div className="empty">Nenhuma compra registrada ainda.</div>
          )}
          {purchasesWithReceipts.map((purchase) => {
            const paidBy = Array.isArray(purchase.paid_by) ? purchase.paid_by[0] : purchase.paid_by;
            const shares = purchase.shopping_purchase_shares ?? [];
            const purchaseItems = purchase.items ?? [];
            const canConfirm = canManageShopping || profile.member_id === purchase.paid_by_member_id;
            return (
              <article className="purchase-card" key={purchase.id}>
                <div className="purchase-summary">
                  <div className="item-title">
                    <strong>{purchaseItems.map((item) => item.name).join(", ") || "Compra"}</strong>
                    <small>
                      {purchaseItems.length} item(ns) • {new Date(purchase.bought_at).toLocaleDateString("pt-BR")}
                    </small>
                  </div>
                  <span className="status-pill violet">
                    {purchaseScopeLabels[purchase.purchase_scope] ?? "Sem rateio"}
                  </span>
                  <div className="item-value">
                    <strong>{currency.format(Number(purchase.total_amount))}</strong>
                    <small>total</small>
                  </div>
                  {canManageShopping && (
                    <div className="purchase-actions">
                      <form action={resetShoppingPurchase}>
                        <input type="hidden" name="purchase_id" value={purchase.id} />
                        <input type="hidden" name="redirect_to" value={baseRoute} />
                        <button className="button ghost small" type="submit">Voltar itens à lista</button>
                      </form>
                    </div>
                  )}
                </div>

                <div className="purchase-items-breakdown">
                  {purchaseItems.map((item) => (
                    <div key={item.id}>
                      <span>{item.name}</span>
                      <strong>
                        {item.quantity_bought ?? "—"} × {currency.format(Number(item.unit_price ?? 0))}
                      </strong>
                      {canManageShopping && (
                        <form action={removeItemFromShoppingPurchase}>
                          <input type="hidden" name="purchase_id" value={purchase.id} />
                          <input type="hidden" name="item_id" value={item.id} />
                          <input type="hidden" name="redirect_to" value={baseRoute} />
                          <button className="button danger small" type="submit">Retirar da compra</button>
                        </form>
                      )}
                    </div>
                  ))}
                </div>

                <div className="purchase-payer">
                  <div>
                    <span>Pago por</span>
                    <strong>{paidBy?.name ?? "Pagador não informado"}</strong>
                  </div>
                  <div>
                    <span>PIX para o saldo líquido</span>
                    <strong>{paidBy?.pix_key ?? "Chave PIX não cadastrada"}</strong>
                  </div>
                </div>

                {shares.length > 0 && (
                  <div className="purchase-shares">
                    <p className="note purchase-shares-note">
                      Partes brutas desta compra. O valor do Pix é compensado com dívidas no sentido contrário na Minha página.
                    </p>
                    {shares.map((share) => {
                      const member = Array.isArray(share.member) ? share.member[0] : share.member;
                      const isPayerShare = share.member_id === purchase.paid_by_member_id;
                      const hasReceipt = Boolean(share.receipt_path);
                      const isConfirmed = share.payment_status === "paid";
                      return (
                        <div className="purchase-share" key={share.id}>
                          <div className="item-title">
                            <strong>{member?.name ?? "Morador"}</strong>
                            <small>{isPayerShare ? "Parte de quem pagou" : `Deve a ${paidBy?.name ?? "quem pagou"}`}</small>
                          </div>
                          <div className="item-value">
                            <strong>{currency.format(Number(share.amount))}</strong>
                            <small>parte individual</small>
                          </div>
                          <span className={`status-pill ${isConfirmed ? "success" : hasReceipt ? "info" : "warning"}`}>
                            {isConfirmed ? "Quitado" : hasReceipt ? "Comprovante enviado" : "PIX pendente"}
                          </span>

                          {hasReceipt && (
                            <div className="purchase-proof-actions">
                              {share.receipt_url && (
                                <div className="attachment-row">
                                  <a href={share.receipt_url} target="_blank" rel="noreferrer">
                                    Ver {share.receipt_name ?? "comprovante"}
                                  </a>
                                </div>
                              )}
                              {!isPayerShare && canConfirm && !isConfirmed && (
                                <form action={confirmShoppingNetPayment}>
                                  <input type="hidden" name="share_id" value={share.id} />
                                  <input type="hidden" name="redirect_to" value={baseRoute} />
                                  <button className="button secondary small" type="submit">Confirmar Pix</button>
                                </form>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}

          {legacyBought.map((item) => (
            <article className="purchase-card" key={item.id}>
              <div className="purchase-summary">
                <div className="item-title">
                  <strong>{item.name}</strong>
                  <small>Compra antiga sem rateio consolidado</small>
                </div>
                <span className="status-pill muted">Legado</span>
                <div className="item-value">
                  <strong>{currency.format(Number(item.quantity_bought ?? 0) * Number(item.unit_price ?? 0))}</strong>
                  <small>total</small>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
