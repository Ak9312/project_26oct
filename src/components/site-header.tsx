import type { ReactNode } from "react";
import { Badge } from "./ui/primitives";
import { Seal } from "./seal";

/** Navy service header with a "Demo" notice, shared by the public and admin pages. */
export function SiteHeader({ title, tag, actions }: { title: string; tag?: string; actions?: ReactNode }) {
  return (
    <header className="bg-brand text-brand-foreground">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Seal size={28} className="shrink-0 text-brand-foreground" />
          <span className="truncate text-[17px] font-bold tracking-tight">{title}</span>
          {tag && (
            <Badge variant="demo" className="ml-1 hidden sm:inline-flex">
              {tag}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
    </header>
  );
}

/** Phase banner: says plainly what this service is and isn't. */
export function DemoBanner() {
  return (
    <div className="border-b bg-muted">
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-4 py-2.5 text-sm sm:px-6">
        <Badge variant="default" className="mt-px">
          Demo
        </Badge>
        <p className="text-muted-foreground">
          An independent project that answers only from published public documents. It is not an official government service.
        </p>
      </div>
    </div>
  );
}
