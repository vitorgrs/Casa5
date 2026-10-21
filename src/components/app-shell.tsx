"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { Logo } from "@/components/logo";
import { BankIcon, BellIcon, CartIcon, HomeIcon, LogoutIcon, MessageIcon, SettingsIcon, SparkIcon, UsersIcon, WalletIcon } from "@/components/icons";
import type { AppProfile } from "@/lib/auth";
import { canSeePage, pageHref, type PageKey } from "@/lib/permissions";

// `pages`: o item aparece quando ao menos uma dessas páginas está visível.
// Casa em dia agrupa várias abas; o link leva à primeira aba liberada.
const nav: { href: string; label: string; icon: typeof HomeIcon; pages: PageKey[] }[] = [
  { href: "/app", label: "Visão geral", icon: HomeIcon, pages: ["overview"] },
  { href: "/app/eu", label: "Minha página", icon: UsersIcon, pages: ["me"] },
  { href: "/app/despesas", label: "Despesas", icon: WalletIcon, pages: ["expenses"] },
  { href: "/app/financeiro", label: "Conta da casa", icon: BankIcon, pages: ["finance"] },
  {
    href: "/app/limpeza",
    label: "Casa em dia",
    icon: SparkIcon,
    pages: ["chores", "laundry", "water", "stove", "dish_rack", "house_map"],
  },
  { href: "/app/organizacao", label: "Compras", icon: CartIcon, pages: ["shopping"] },
  { href: "/app/reclamacoes", label: "Reclamações", icon: MessageIcon, pages: ["complaints"] },
  { href: "/app/moradores", label: "Moradores", icon: UsersIcon, pages: ["members"] },
  { href: "/app/configuracoes", label: "Configurações", icon: SettingsIcon, pages: ["settings"] }
];

export function AppShell({ profile, children, alertCount = 0 }: { profile: AppProfile; children: ReactNode; alertCount?: number }) {
  const pathname = usePathname();

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Logo />
        <nav className="sidebar-nav">
          {nav.map(({ href: sectionHref, label, icon: Icon, pages }) => {
            const visiblePages = pages.filter((page) => canSeePage(profile, page));
            if (visiblePages.length === 0) return null;
            const href =
              visiblePages[0] === pages[0] ? sectionHref : pageHref(visiblePages[0]);
            const active = sectionHref === "/app" ? pathname === sectionHref : pathname.startsWith(sectionHref);
            return (
              <Link className={`nav-link ${active ? "active" : ""}`} href={href} key={sectionHref}>
                <Icon />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="profile-mini">
            <div className="avatar avatar-violet">{profile.full_name.slice(0, 1).toUpperCase()}</div>
            <div><strong>{profile.full_name}</strong><small>{profile.role === "admin" ? "Administrador" : "Morador"}</small></div>
          </div>
          <form action={signOut}><button className="icon-button" title="Sair"><LogoutIcon /></button></form>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div>
            <span className="eyebrow">Apartamento • Rio de Janeiro</span>
            <strong className="topbar-title">Painel da Casa</strong>
          </div>
          <div className="topbar-actions">
            <div className="role-chip">{profile.role === "admin" ? "Modo administrador" : "Acesso de morador"}</div>
            <button className="icon-button notification-button" aria-label="Alertas">
              <BellIcon />
              {alertCount > 0 && <span>{alertCount}</span>}
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
