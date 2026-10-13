import Link from "next/link";
import {
  CheckIcon,
  FireIcon,
  HomeIcon,
  LaundryIcon,
  WaterIcon,
} from "@/components/icons";

type CasaEmDiaSection = "tarefas" | "lavanderia" | "agua" | "fogao" | "mapa";

const sections = [
  {
    key: "tarefas" as const,
    href: "/app/limpeza",
    label: "Tarefas do dia",
    icon: CheckIcon,
  },
  {
    key: "lavanderia" as const,
    href: "/app/limpeza/lavanderia",
    label: "Lavanderia",
    icon: LaundryIcon,
  },
  {
    key: "agua" as const,
    href: "/app/limpeza/agua",
    label: "Galão de água",
    icon: WaterIcon,
  },
  {
    key: "fogao" as const,
    href: "/app/limpeza/fogao",
    label: "Limpeza do fogão",
    icon: FireIcon,
  },
  {
    key: "mapa" as const,
    href: "/app/limpeza/mapa",
    label: "Mapa da casa",
    icon: HomeIcon,
  },
];

export function CasaEmDiaTabs({ active }: { active: CasaEmDiaSection }) {
  return (
    <nav className="casa-em-dia-tabs" aria-label="Áreas do Casa em dia">
      {sections.map(({ key, href, label, icon: Icon }) => (
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
