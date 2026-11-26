"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { Logo } from "@/components/logo";
import {
  BankIcon,
  BellIcon,
  CartIcon,
  CloseIcon,
  HomeIcon,
  LogoutIcon,
  MenuIcon,
  MessageIcon,
  SettingsIcon,
  SparkIcon,
  UserIcon,
  UsersIcon,
  WalletIcon,
} from "@/components/icons";
import type { AppProfile } from "@/lib/auth";
import { canSeePage, pageHref, type PageKey } from "@/lib/permissions";

type NavItem = {
  href: string;
  label: string;
  shortLabel: string;
  icon: typeof HomeIcon;
  pages: PageKey[];
};

// `pages`: o item aparece quando ao menos uma dessas páginas está visível.
// Casa em dia agrupa várias abas; o link leva à primeira aba liberada.
const nav: NavItem[] = [
  { href: "/app", label: "Visão geral", shortLabel: "Início", icon: HomeIcon, pages: ["overview"] },
  { href: "/app/eu", label: "Minha página", shortLabel: "Eu", icon: UserIcon, pages: ["me"] },
  {
    href: "/app/limpeza",
    label: "Casa em dia",
    shortLabel: "Casa",
    icon: SparkIcon,
    pages: ["chores", "laundry", "water", "stove", "dish_rack", "house_map"],
  },
  { href: "/app/organizacao", label: "Compras", shortLabel: "Compras", icon: CartIcon, pages: ["shopping"] },
  { href: "/app/despesas", label: "Despesas", shortLabel: "Despesas", icon: WalletIcon, pages: ["expenses"] },
  { href: "/app/financeiro", label: "Conta da casa", shortLabel: "Conta", icon: BankIcon, pages: ["finance"] },
  { href: "/app/reclamacoes", label: "Reclamações", shortLabel: "Reclamações", icon: MessageIcon, pages: ["complaints"] },
  { href: "/app/moradores", label: "Moradores", shortLabel: "Moradores", icon: UsersIcon, pages: ["members"] },
  { href: "/app/configuracoes", label: "Configurações", shortLabel: "Ajustes", icon: SettingsIcon, pages: ["settings"] },
];

// Quantos destinos ficam fixos na barra inferior do celular; os demais vão
// para o painel "Mais".
const BOTTOM_NAV_SLOTS = 4;

function isActive(pathname: string, href: string) {
  return href === "/app" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  profile,
  children,
  unreadCount = 0,
}: {
  profile: AppProfile;
  children: ReactNode;
  unreadCount?: number;
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const visibleNav = nav
    .map((item) => {
      const visiblePages = item.pages.filter((page) => canSeePage(profile, page));
      if (visiblePages.length === 0) return null;
      const href = visiblePages[0] === item.pages[0] ? item.href : pageHref(visiblePages[0]);
      return { ...item, linkHref: href };
    })
    .filter((item): item is NavItem & { linkHref: string } => item !== null);

  const primaryNav = visibleNav.slice(0, BOTTOM_NAV_SLOTS);
  const secondaryNav = visibleNav.slice(BOTTOM_NAV_SLOTS);
  const secondaryActive = secondaryNav.some((item) => isActive(pathname, item.href));
  const firstName = profile.full_name.split(" ")[0];
  const currentSection =
    pathname === "/app/notificacoes"
      ? "Notificações"
      : (visibleNav.find((item) => isActive(pathname, item.href))?.label ?? `Olá, ${firstName}`);
  const unreadLabel =
    unreadCount > 0
      ? `Notificações: ${unreadCount} não ${unreadCount === 1 ? "lida" : "lidas"}`
      : "Notificações";

  // Fecha o painel ao trocar de página.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  // Painel "Mais": Esc fecha, o foco vai para o primeiro link ao abrir e
  // volta para o botão ao fechar; a página atrás não rola.
  useEffect(() => {
    if (!moreOpen) return;
    const button = moreButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMoreOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      button?.focus();
    };
  }, [moreOpen]);

  return (
    <div className="app-frame">
      <a className="skip-link" href="#conteudo">Pular para o conteúdo</a>

      <aside className="sidebar" aria-label="Menu principal">
        <Logo />
        <nav className="sidebar-nav">
          {visibleNav.map(({ href, linkHref, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                className={`nav-link ${active ? "active" : ""}`}
                href={linkHref}
                key={href}
                aria-current={active ? "page" : undefined}
              >
                <Icon />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="profile-mini">
            <div className="avatar avatar-violet" aria-hidden="true">
              {profile.full_name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>{profile.full_name}</strong>
              <small>{profile.role === "admin" ? "Administrador" : "Morador"}</small>
            </div>
          </div>
          <form action={signOut}>
            <button className="icon-button" type="submit" aria-label="Sair da conta" title="Sair">
              <LogoutIcon />
            </button>
          </form>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <Link href="/app" className="topbar-brand" aria-label="Casa Cinco — visão geral">
            <span className="logo-mark small" aria-hidden="true"><span>5</span></span>
            <span className="topbar-brand-text">
              <span className="eyebrow" translate="no">Casa Cinco</span>
              <strong className="topbar-title">{currentSection}</strong>
            </span>
          </Link>
          <div className="topbar-actions">
            <div className="role-chip">
              {profile.role === "admin" ? "Modo administrador" : "Acesso de morador"}
            </div>
            <Link
              href="/app/notificacoes"
              className={`icon-button notification-button ${pathname === "/app/notificacoes" ? "active" : ""}`}
              aria-label={unreadLabel}
              title={unreadLabel}
            >
              <BellIcon />
              {unreadCount > 0 && (
                <span aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>
              )}
            </Link>
          </div>
        </header>
        <main className="content" id="conteudo" tabIndex={-1}>
          {children}
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Navegação principal">
        {primaryNav.map(({ href, linkHref, shortLabel, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={linkHref}
              className={`bottom-nav-link ${active ? "active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <Icon />
              <span>{shortLabel}</span>
            </Link>
          );
        })}
        <button
          ref={moreButtonRef}
          type="button"
          className={`bottom-nav-link ${secondaryActive || moreOpen ? "active" : ""}`}
          aria-expanded={moreOpen}
          aria-controls="menu-mais"
          onClick={() => setMoreOpen((open) => !open)}
        >
          <MenuIcon />
          <span>Mais</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div
            ref={sheetRef}
            id="menu-mais"
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Mais opções"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-profile">
              <div className="avatar avatar-violet" aria-hidden="true">
                {profile.full_name.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <strong>{profile.full_name}</strong>
                <small>{profile.role === "admin" ? "Administrador" : "Morador"}</small>
              </div>
              <button
                type="button"
                className="icon-button sheet-close"
                aria-label="Fechar menu"
                onClick={() => setMoreOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <nav className="sheet-nav" aria-label="Outras páginas">
              <Link
                href="/app/notificacoes"
                className={`sheet-link ${pathname === "/app/notificacoes" ? "active" : ""}`}
              >
                <BellIcon />
                <span>Notificações</span>
                {unreadCount > 0 && <span className="count-badge">{unreadCount}</span>}
              </Link>
              {secondaryNav.map(({ href, linkHref, label, icon: Icon }) => {
                const active = isActive(pathname, href);
                return (
                  <Link
                    key={href}
                    href={linkHref}
                    className={`sheet-link ${active ? "active" : ""}`}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </nav>
            <form action={signOut}>
              <button className="sheet-link danger" type="submit">
                <LogoutIcon />
                <span>Sair da conta</span>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
