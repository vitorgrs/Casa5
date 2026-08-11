import Link from "next/link";
import { AttachmentUploadForm } from "@/components/attachment-upload-form";
import { CartIcon, ChecklistIcon, PlusIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requireActiveProfile } from "@/lib/auth";
import { currency } from "@/lib/format";
import { signedReceiptUrl } from "@/lib/storage";
import {
  addShoppingItem,
  confirmShoppingSharePayment,
  createTask,
  deleteShoppingItem,
  deleteTask,
  resetShoppingItem,
  toggleShoppingChecked,
  toggleTaskAssignee,
  uploadShoppingShareReceipt,
} from "./actions";
import { ShoppingPurchaseForm } from "./shopping-purchase-form";

const purchaseScopeLabels: Record<string, string> = {
  household: "Casa toda",
  group: "Grupo",
  individual: "Individual",
};

export default async function OrganizacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ nova?: string; item?: string; success?: string }>;
}) {
  const params = await searchParams;
  const baseRoute = "/app/organizacao";
  const { profile, supabase } = await requireActiveProfile();
  const canManageTasks = can(profile, "manage_tasks");
  const canManageShopping = can(profile, "manage_shopping");

  const [{ data: members }, { data: tasks }, { data: shoppingItems }] =
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
          "id,name,note,category,status,quantity_planned,quantity_bought,unit_price,purchase_scope,paid_by_member_id,checked_at,bought_at,created_at,paid_by:household_members!shopping_items_paid_by_member_id_fkey(id,name,pix_key),shopping_item_shares(id,member_id,amount,payment_status,paid_at,receipt_path,receipt_name,receipt_uploaded_at,member:household_members(id,name))",
        )
        .eq("household_id", profile.household_id)
        .order("created_at", { ascending: false }),
    ]);

  const openTasks = (tasks ?? []).filter((t) =>
    (t.task_assignees ?? []).length === 0
      ? true
      : (t.task_assignees ?? []).some((a) => !a.done),
  );
  const doneTasks = (tasks ?? []).filter(
    (t) => (t.task_assignees ?? []).length > 0 && (t.task_assignees ?? []).every((a) => a.done),
  );

  const shoppingItemsWithReceipts = await Promise.all(
    (shoppingItems ?? []).map(async (item) => ({
      ...item,
      shopping_item_shares: await Promise.all(
        (item.shopping_item_shares ?? []).map(async (share) => ({
          ...share,
          receipt_url: await signedReceiptUrl(supabase, share.receipt_path),
        })),
      ),
    })),
  );

  const toBuy = shoppingItemsWithReceipts.filter((i) => i.status === "list");
  const checked = shoppingItemsWithReceipts.filter((i) => i.status === "checked");
  const bought = shoppingItemsWithReceipts.filter((i) => i.status === "bought");
  const selectedItem = [...toBuy, ...checked].find((item) => item.id === params.item);
  const totalSpent = bought.reduce(
    (sum, i) => sum + (Number(i.quantity_bought ?? 0) * Number(i.unit_price ?? 0)),
    0,
  );

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
            Checklist do mercado ({toBuy.length + checked.length} itens)
          </h4>
        </div>
        <div className="list">
          {[...toBuy, ...checked].length === 0 && (
            <div className="empty">Nenhum item na lista de compras.</div>
          )}
          {[...checked, ...toBuy].map((item) => (
            <div className="list-row" key={item.id}>
              <div className="item-title">
                <strong className={item.status === "checked" ? "strike" : undefined}>
                  {item.name}
                </strong>
                <small>
                  {item.quantity_planned ? `${item.quantity_planned} • ` : ""}
                  {item.category ?? ""}
                </small>
              </div>
              <span className={`status-pill ${item.status === "checked" ? "success" : "info"}`}>
                {item.status === "checked" ? "No carrinho" : "Falta comprar"}
              </span>
              {canManageShopping && (
                <form action={toggleShoppingChecked}>
                  <input type="hidden" name="item_id" value={item.id} />
                  <input
                    type="hidden"
                    name="next_status"
                    value={item.status === "checked" ? "list" : "checked"}
                  />
                  <input type="hidden" name="redirect_to" value={baseRoute} />
                  <button className="button ghost small" type="submit">
                    {item.status === "checked" ? "Desmarcar" : "Marcar"}
                  </button>
                </form>
              )}
              {canManageShopping && (
                <Link className="button secondary small" href={`${baseRoute}?item=${item.id}#compra`}>
                  Lançar compra
                </Link>
              )}
            </div>
          ))}
        </div>

        {selectedItem && canManageShopping && (
          <div id="compra" className="purchase-form-wrap">
            <ShoppingPurchaseForm
              itemId={selectedItem.id}
              itemName={selectedItem.name}
              members={(members ?? []).map((member) => ({ id: member.id, name: member.name }))}
              currentMemberId={profile.member_id}
              redirectTo={baseRoute}
            />
          </div>
        )}

        <div style={{ padding: "0 20px 8px" }}>
          <h4 style={{ margin: "8px 0" }}>Já comprados ({bought.length})</h4>
        </div>
        <div className="purchase-list">
          {bought.length === 0 && <div className="empty">Nenhuma compra registrada ainda.</div>}
          {bought.map((item) => {
            const paidBy = Array.isArray(item.paid_by) ? item.paid_by[0] : item.paid_by;
            const shares = item.shopping_item_shares ?? [];
            const total = Number(item.quantity_bought ?? 0) * Number(item.unit_price ?? 0);
            const canConfirm = canManageShopping || profile.member_id === item.paid_by_member_id;
            return (
              <article className="purchase-card" key={item.id}>
                <div className="purchase-summary">
                  <div className="item-title">
                    <strong>{item.name}</strong>
                    <small>
                      {item.category ?? "Sem categoria"} • {item.quantity_bought ?? "—"} × {item.unit_price
                        ? currency.format(Number(item.unit_price))
                        : "—"}
                    </small>
                  </div>
                  <span className="status-pill violet">
                    {purchaseScopeLabels[item.purchase_scope ?? ""] ?? "Sem rateio"}
                  </span>
                  <div className="item-value">
                    <strong>{currency.format(total)}</strong>
                    <small>total</small>
                  </div>
                  {canManageShopping && (
                    <div className="purchase-actions">
                      <form action={resetShoppingItem}>
                        <input type="hidden" name="item_id" value={item.id} />
                        <input type="hidden" name="redirect_to" value={baseRoute} />
                        <button className="button ghost small" type="submit">Voltar à lista</button>
                      </form>
                      <form action={deleteShoppingItem}>
                        <input type="hidden" name="item_id" value={item.id} />
                        <input type="hidden" name="redirect_to" value={baseRoute} />
                        <button className="button danger small" type="submit">Excluir</button>
                      </form>
                    </div>
                  )}
                </div>

                {paidBy ? (
                  <div className="purchase-payer">
                    <div>
                      <span>Pago por</span>
                      <strong>{paidBy.name}</strong>
                    </div>
                    <div>
                      <span>PIX para reembolso</span>
                      <strong>{paidBy.pix_key ?? "Chave PIX não cadastrada"}</strong>
                    </div>
                  </div>
                ) : (
                  <p className="note" style={{ padding: "0 20px" }}>
                    Compra antiga, registrada antes do recurso de rateio.
                  </p>
                )}

                {shares.length > 0 && (
                  <div className="purchase-shares">
                    {shares.map((share) => {
                      const member = Array.isArray(share.member) ? share.member[0] : share.member;
                      const isPayerShare = share.member_id === item.paid_by_member_id;
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

                          {!isPayerShare && share.member_id === profile.member_id && !isConfirmed && !hasReceipt && (
                            <AttachmentUploadForm
                              action={uploadShoppingShareReceipt}
                              hiddenFields={{ share_id: share.id }}
                              redirectTo={baseRoute}
                              label="Enviar comprovante"
                            />
                          )}

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
                                <form action={confirmShoppingSharePayment}>
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
        </div>
      </section>
    </>
  );
}
