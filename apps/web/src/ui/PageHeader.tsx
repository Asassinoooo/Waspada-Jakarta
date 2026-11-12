import type { ReactNode } from "react";

export interface PageHeaderProps {
  /** Short label above the title, for example "Bantuan · informasi dan kontrol". */
  eyebrow?: string;
  /** The screen title. It renders the only h1 on the screen. */
  title: string;
  /** Optional one-paragraph summary under the title. */
  lead?: ReactNode;
  /** Optional single control. Keep it quiet unless it is the page's one primary action. */
  action?: ReactNode;
  /** Id for the h1, so a section can name itself with aria-labelledby. */
  titleId?: string;
}

/**
 * Title block for the secondary screens (UI-V2-D). Pair it with `.page-column` for the reading width.
 * It holds no state and never renders a second heading.
 */
export function PageHeader({ eyebrow, title, lead, action, titleId }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        {eyebrow ? <p className="page-header__eyebrow">{eyebrow}</p> : null}
        <h1 id={titleId} className="page-header__title">{title}</h1>
        {lead ? <p className="page-header__lead">{lead}</p> : null}
      </div>
      {action ? <div className="page-header__action">{action}</div> : null}
    </header>
  );
}
