import type { ReactNode } from "react";

/**
 * The top of every dashboard screen (UI-1 to UI-6): a numbered section label, the
 * page's one `h1`, and a single sentence that says what the numbers below are. It is
 * presentational; pages pass their own actions so an export link sits on the screen
 * that owns the data.
 */
export type PageHeaderProps = {
  readonly index: string;
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
};

export function PageHeader({ index, title, description, actions }: PageHeaderProps) {
  return (
    <header className="mb-10 flex flex-col gap-6 border-b border-line pb-8 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
      <div>
        <p className="eyebrow flex items-center gap-3">
          <span aria-hidden className="h-px w-6 bg-acid" />
          {index}
        </p>
        <h1 className="mt-4 text-[2.6rem] font-semibold leading-none tracking-[-0.035em] sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-6 text-muted">{description}</p>
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-3">{actions}</div>
      )}
    </header>
  );
}
