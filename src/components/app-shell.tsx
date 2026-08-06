"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { Logo } from "@/components/logo";
import { BellIcon, ChecklistIcon, HomeIcon, LogoutIcon, SettingsIcon, SparkIcon, UsersIcon, WalletIcon } from "@/components/icons";
import type { AppProfile } from "@/lib/auth";

const nav = [
  { href: "/app", label: "Visão geral", icon: HomeIcon },
  { href: "/app/eu", label: "Minha página", icon: UsersIcon },
  { href: "/app/despesas", label: "Despesas", icon: WalletIcon },
  { href: "/app/limpeza", label: "Casa em dia", icon: SparkIcon },
  { href: "/app/organizacao", label: "Organização", icon: ChecklistIcon },
  { href: "/app/moradores", label: "Moradores", icon: UsersIcon },
  { href: "/app/configuracoes", label: "Configurações", icon: SettingsIcon }
];

export function AppShell({ profile, children, alertCount = 0 }: { profile: AppProfile; children: ReactNode; alertCount?: number }) {
  const pathname = usePathname();

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Logo />
        <nav className="sidebar-nav">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === "/app" ? pathname === href : pathname.startsWith(href);
            return (
              <Link className={`nav-link ${active ? "active" : ""}`} href={href} key={href}>
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
