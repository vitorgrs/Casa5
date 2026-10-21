import Link from "next/link";
import { canSeePage, type PageKey } from "@/lib/permissions";
import {
  CheckIcon,
  DishIcon,
  FireIcon,
  HomeIcon,
  LaundryIcon,
  WaterIcon,
} from "@/components/icons";

type CasaEmDiaSection =
  | "tarefas"
  | "lavanderia"
  | "agua"
  | "fogao"
  | "louca"
  | "mapa";

const sections = [
  {
    key: "tarefas" as const,
    page: "chores" as PageKey,
    href: "/app/limpeza",
    label: "Tarefas do dia",
    icon: CheckIcon,
  },
  {
    key: "lavanderia" as const,
    page: "laundry" as PageKey,
    href: "/app/limpeza/lavanderia",
    label: "Lavanderia",
    icon: LaundryIcon,
  },
  {
    key: "agua" as const,
    page: "water" as PageKey,
    href: "/app/limpeza/agua",
    label: "Galão de água",
    icon: WaterIcon,
  },
  {
    key: "fogao" as const,
    page: "stove" as PageKey,
    href: "/app/limpeza/fogao",
    label: "Limpeza do fogão",
    icon: FireIcon,
  },
  {
    key: "louca" as const,
    page: "dish_rack" as PageKey,
    href: "/app/limpeza/louca",
    label: "Lava e seca-louça",
    icon: DishIcon,
  },
  {
    key: "mapa" as const,
    page: "house_map" as PageKey,
    href: "/app/limpeza/mapa",
    label: "Mapa da casa",
    icon: HomeIcon,
  },
];

export function CasaEmDiaTabs({
  active,
  profile,
}: {
  active: CasaEmDiaSection;
  profile: Parameters<typeof canSeePage>[0];
}) {
  const visibleSections = sections.filter((section) =>
    canSeePage(profile, section.page),
  );
  return (
    <nav className="casa-em-dia-tabs" aria-label="Áreas do Casa em dia">
      {visibleSections.map(({ key, href, label, icon: Icon }) => (
        <Link
          className={`casa-em-dia-tab ${active === key ? "active" : ""}`}
          href={href}
          aria-current={active === key ? "page" : undefined}
          key={key}
        >
          <Icon />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
