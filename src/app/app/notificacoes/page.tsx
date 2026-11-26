import Link from "next/link";
import {
  BellIcon,
  CalendarIcon,
  CartIcon,
  CheckIcon,
  SparkIcon,
  UsersIcon,
  WalletIcon,
} from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { requireActiveProfile } from "@/lib/auth";
import type { AppNotification } from "@/lib/notifications";
import { markAllNotificationsRead, openNotification } from "./actions";

export const dynamic = "force-dynamic";

const KIND_ICONS: Record<string, typeof BellIcon> = {
  expense_created: WalletIcon,
  purchase_created: CartIcon,
  purchase_request_pending: CartIcon,
  purchase_request_approved: CartIcon,
  purchase_request_rejected: CartIcon,
  task_assigned: CheckIcon,
  duty_today: CalendarIcon,
  rotation_turn: SparkIcon,
  swap_requested: CalendarIcon,
  swap_pending: CalendarIcon,
  swap_approved: CalendarIcon,
  swap_rejected: CalendarIcon,
  member_away: UsersIcon,
  member_returned: UsersIcon,
};

function relativeTime(iso: string) {
  const diffMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMinutes < 1) return "agora";
  if (diffMinutes < 60) return `há ${diffMinutes} min`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `há ${diffHours} h`;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default async function NotificationsPage() {
  const { profile, supabase } = await requireActiveProfile();
  const { data, error } = profile.member_id
    ? await supabase
        .from("notifications")
        .select("id,kind,title,body,link,created_at,read_at")
        .eq("member_id", profile.member_id)
        .order("created_at", { ascending: false })
        .limit(80)
    : { data: [], error: null };
  const notifications = (data ?? []) as AppNotification[];
  const unread = notifications.filter((item) => !item.read_at).length;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Avisos</span>
          <h1>Notificações</h1>
          <p>
            Cadastros que envolvem você, seus dias nos rodízios e as compras
            aguardando revisão.
          </p>
        </div>
        {unread > 0 && (
          <form action={markAllNotificationsRead} className="page-actions">
            <SubmitButton className="button secondary" pendingLabel="Marcando…">
              <CheckIcon /> Marcar todas como lidas
            </SubmitButton>
          </form>
        )}
      </div>

      {!profile.member_id && (
        <div className="message info">
          Sua conta ainda não está vinculada a um morador, por isso não há
          notificações para mostrar.
        </div>
      )}
      {error && (
        <div className="message info">
          As notificações ficam disponíveis depois que a migration 038 for
          aplicada no banco.
        </div>
      )}

      <section className="card" aria-labelledby="lista-notificacoes">
        <div className="card-head">
          <h2 id="lista-notificacoes">
            {unread > 0 ? `${unread} não ${unread === 1 ? "lida" : "lidas"}` : "Tudo em dia"}
          </h2>
          <span className="muted-text card-subtitle">Últimos 80 avisos</span>
        </div>
        {notifications.length === 0 ? (
          <div className="empty-state">
            <BellIcon />
            <strong>Nenhuma notificação por enquanto</strong>
            <span>Quando algo envolver você, o aviso aparece aqui.</span>
            <Link className="button secondary" href="/app">Voltar ao início</Link>
          </div>
        ) : (
          <ul className="notification-list">
            {notifications.map((item) => {
              const Icon = KIND_ICONS[item.kind] ?? BellIcon;
              return (
                <li key={item.id}>
                  <form action={openNotification}>
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="link" value={item.link ?? "/app/notificacoes"} />
                    <button
                      type="submit"
                      className={`notification-item ${item.read_at ? "" : "unread"}`}
                    >
                      <span className="notification-icon" aria-hidden="true"><Icon /></span>
                      <span className="notification-text">
                        <strong>{item.title}</strong>
                        {item.body && <span>{item.body}</span>}
                        <small>
                          {relativeTime(item.created_at)}
                          {!item.read_at && <span className="sr-only"> • não lida</span>}
                        </small>
                      </span>
                      {!item.read_at && <span className="unread-dot" aria-hidden="true" />}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
