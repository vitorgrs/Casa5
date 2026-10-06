import Link from "next/link";
import { redirect } from "next/navigation";
import { CartIcon, ChecklistIcon, PlusIcon } from "@/components/icons";
import { can, requireActiveProfile } from "@/lib/auth";
import { currency } from "@/lib/format";
import {
  ShoppingItemCreateForm,
  ShoppingListManager,
  ShoppingPurchaseMutationForm,
} from "./shopping-purchase-form";
import { TaskCreateForm, TaskMutationForm } from "./task-forms";

const purchaseScopeLabels: Record<string, string> = {
  household: "Casa toda",
  group: "Grupo",
  individual: "Individual",
};

const purchaseSplitLabels: Record<string, string> = {
  equal: "Divisão igual",
  custom: "Valores personalizados",
};

const PURCHASES_PER_PAGE = 10;

export default async function OrganizacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ nova?: string; success?: string; compras_page?: string }>;
}) {
  const params = await searchParams;
  const parsedPurchasePage = Number(params.compras_page ?? "1");
  const purchasePage = Number.isSafeInteger(parsedPurchasePage) &&
    parsedPurchasePage > 0 &&
    parsedPurchasePage <= 10_000
    ? parsedPurchasePage
    : 1;
  const purchaseFrom = (purchasePage - 1) * PURCHASES_PER_PAGE;
  const purchaseTo = purchaseFrom + PURCHASES_PER_PAGE - 1;
  const baseRoute = "/app/organizacao";
  const { profile, supabase } = await requireActiveProfile();
  const canManageTasks = can(profile, "manage_tasks");
  const canManageShopping = profile.role === "admin";

  const [
    { data: members },
    { data: tasks },
    { data: shoppingItems },
    { data: purchases, count: purchaseCount },
    { data: legacyBought },
    { data: purchaseTotals },
  ] = await Promise.all([
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
          "id,name,note,category,status,quantity_planned,created_at",
        )
        .eq("household_id", profile.household_id)
        .in("status", ["list", "checked"])
        .order("created_at", { ascending: false }),
      supabase
        .from("shopping_purchases")
        .select(
          "id,purchase_scope,split_mode,total_amount,bought_at,paid_by_member_id,paid_by:household_members!shopping_purchases_paid_by_member_id_fkey(id,name,pix_key),items:shopping_items(id,name,category,quantity_bought,unit_price),shopping_purchase_shares(id,member_id,amount,payment_status,paid_at,receipt_path,receipt_name,receipt_uploaded_at,member:household_members(id,name))",
          { count: "exact" },
        )
        .eq("household_id", profile.household_id)
        .order("bought_at", { ascending: false })
        .range(purchaseFrom, purchaseTo),
      supabase
        .from("shopping_items")
        .select("id,name,quantity_bought,unit_price")
        .eq("household_id", profile.household_id)
        .eq("status", "bought")
        .is("purchase_id", null)
        .order("bought_at", { ascending: false }),
      supabase
        .from("shopping_purchases")
        .select("total_amount")
        .eq("household_id", profile.household_id),
    ]);

  const openTasks = (tasks ?? []).filter((t) =>
    (t.task_assignees ?? []).length === 0
      ? true
      : (t.task_assignees ?? []).some((a) => !a.done),
  );
  const doneTasks = (tasks ?? []).filter(
    (t) => (t.task_assignees ?? []).length > 0 && (t.task_assignees ?? []).every((a) => a.done),
  );

  const openShoppingItems = shoppingItems ?? [];
  const purchasesOnPage = purchases ?? [];
  const legacyPurchases = purchasePage === 1 ? (legacyBought ?? []) : [];
  const totalPurchasePages = Math.max(
    1,
    Math.ceil((purchaseCount ?? 0) / PURCHASES_PER_PAGE),
  );
  if (purchasePage > totalPurchasePages) {
    redirect(
      `${baseRoute}?compras_page=${totalPurchasePages}#historico-compras`,
    );
  }
  const totalSpent = (purchaseTotals ?? []).reduce(
    (sum, purchase) => sum + Number(purchase.total_amount),
    0,
  ) + (legacyBought ?? []).reduce(
    (sum, item) => sum + Number(item.quantity_bought ?? 0) * Number(item.unit_price ?? 0),
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
            <TaskCreateForm
              members={(members ?? []).map((member) => ({ id: member.id, name: member.name }))}
              redirectTo={baseRoute}
              cancelHref={baseRoute}
            />
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
                    <TaskMutationForm
                      key={a.id}
                      mode="toggle"
                      assigneeId={a.id}
                      done={!a.done}
                      redirectTo={baseRoute}
                      className={`button small ${a.done ? "secondary" : "ghost"}`}
                      title={a.done ? "Marcar como pendente" : "Marcar como concluída"}
                      label={`${a.done ? "✓ " : ""}${member?.name?.split(" ")[0] ?? "Morador"}`}
                    />
                  );
                })}
                {(task.task_assignees ?? []).length === 0 && (
                  <span className="muted-text" style={{ fontSize: 12 }}>Sem responsável definido</span>
                )}
              </div>
              {canManageTasks && (
                <TaskMutationForm
                  mode="delete"
                  taskId={task.id}
                  redirectTo={baseRoute}
                  className="button danger small"
                  label="Excluir"
                />
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

        {!canManageShopping && (
          <div className="message info" style={{ margin: "0 20px 20px" }}>
            A lista e os lançamentos de compras são somente para
            visualização. Apenas o administrador pode alterá-los.
          </div>
        )}

        {canManageShopping && (
          <div style={{ padding: "0 20px 20px" }}>
            <ShoppingItemCreateForm redirectTo={baseRoute} />
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
          canManage={canManageShopping}
          redirectTo={baseRoute}
        />

        <div id="historico-compras" style={{ padding: "0 20px 8px" }}>
          <h4 style={{ margin: "8px 0" }}>
            Compras registradas ({(purchaseCount ?? 0) + (legacyBought?.length ?? 0)})
          </h4>
        </div>
        <div className="purchase-list">
          {purchasesOnPage.length === 0 && legacyPurchases.length === 0 && (
            <div className="empty">Nenhuma compra registrada ainda.</div>
          )}
          {purchasesOnPage.map((purchase) => {
            const paidBy = Array.isArray(purchase.paid_by) ? purchase.paid_by[0] : purchase.paid_by;
            const shares = purchase.shopping_purchase_shares ?? [];
            const purchaseItems = purchase.items ?? [];
            return (
              <details className="purchase-card purchase-accordion" key={purchase.id}>
                <summary className="purchase-summary">
                  <div className="item-title">
                    <strong>{purchaseItems.map((item) => item.name).join(", ") || "Compra"}</strong>
                    <small>
                      {purchaseItems.length} item(ns) • {new Date(purchase.bought_at).toLocaleDateString("pt-BR")}
                    </small>
                  </div>
                  <span className="status-pill violet">
                    {purchaseScopeLabels[purchase.purchase_scope] ?? "Sem divisão"} ·{" "}
                    {purchaseSplitLabels[purchase.split_mode] ?? "Divisão igual"}
                  </span>
                  <div className="item-value">
                    <strong>{currency.format(Number(purchase.total_amount))}</strong>
                    <small>total</small>
                  </div>
                  <span className="purchase-accordion-toggle">
                    <span>Detalhes</span>
                    <b aria-hidden="true">⌄</b>
                  </span>
                </summary>

                <div className="purchase-details">
                  {canManageShopping && (
                    <div className="purchase-details-actions">
                      <ShoppingPurchaseMutationForm
                        mode="reset-purchase"
                        purchaseId={purchase.id}
                        redirectTo={baseRoute}
                      />
                    </div>
                  )}

                  <div className="purchase-items-breakdown">
                    {purchaseItems.map((item) => (
                      <div key={item.id}>
                        <span>{item.name}</span>
                        <strong>
                          {item.quantity_bought ?? "—"} × {currency.format(Number(item.unit_price ?? 0))}
                        </strong>
                        {canManageShopping &&
                          (purchase.split_mode !== "custom" || purchaseItems.length === 1) && (
                          <ShoppingPurchaseMutationForm
                            mode="remove-item"
                            purchaseId={purchase.id}
                            itemId={item.id}
                            redirectTo={baseRoute}
                          />
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
                        Partes desta compra. O valor do Pix é compensado com dívidas no sentido contrário na Minha página.
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
                                <div className="attachment-row">
                                  <a
                                    href={`/app/organizacao/comprovantes/${share.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Ver {share.receipt_name ?? "comprovante"}
                                  </a>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </details>
            );
          })}

          {legacyPurchases.map((item) => (
            <details className="purchase-card purchase-accordion" key={item.id}>
              <summary className="purchase-summary">
                <div className="item-title">
                  <strong>{item.name}</strong>
                  <small>Compra antiga sem divisão detalhada</small>
                </div>
                <span className="status-pill muted">Legado</span>
                <div className="item-value">
                  <strong>{currency.format(Number(item.quantity_bought ?? 0) * Number(item.unit_price ?? 0))}</strong>
                  <small>total</small>
                </div>
                <span className="purchase-accordion-toggle">
                  <span>Detalhes</span>
                  <b aria-hidden="true">⌄</b>
                </span>
              </summary>
              <div className="purchase-legacy-details">
                Compra antiga registrada antes do detalhamento por compra. Não há divisão consolidada disponível.
              </div>
            </details>
          ))}
        </div>

        {totalPurchasePages > 1 && (
          <nav
            className="form-actions"
            aria-label="Paginação das compras"
            style={{ justifyContent: "center", padding: "16px 20px 20px" }}
          >
            {purchasePage > 1 ? (
              <Link
                className="button ghost small"
                href={`${baseRoute}?compras_page=${purchasePage - 1}#historico-compras`}
              >
                Anterior
              </Link>
            ) : (
              <button className="button ghost small" type="button" disabled>
                Anterior
              </button>
            )}
            <span className="muted-text">
              Página {Math.min(purchasePage, totalPurchasePages)} de {totalPurchasePages}
            </span>
            {purchasePage < totalPurchasePages ? (
              <Link
                className="button ghost small"
                href={`${baseRoute}?compras_page=${purchasePage + 1}#historico-compras`}
              >
                Próxima
              </Link>
            ) : (
              <button className="button ghost small" type="button" disabled>
                Próxima
              </button>
            )}
          </nav>
        )}
      </section>
    </>
  );
}
