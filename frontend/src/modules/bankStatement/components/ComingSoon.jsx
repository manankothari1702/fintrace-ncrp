/**
 * Placeholder page body for the Bank Statement sections that are routed and
 * navigable in this scaffold pass but not yet built. Uses the shared .page /
 * .card primitives so it already sits in the app's visual language.
 *
 * @param {object} props
 * @param {string} props.title    - Page title (matches the sidebar label).
 * @param {string} props.icon     - Emoji shown in the sidebar for this page.
 * @param {string} props.blurb    - One line on what this page will eventually do.
 */
export default function ComingSoon({ title, icon, blurb }) {
  return (
    <div className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <p className="subtitle">{blurb}</p>
      </header>

      <div className="card card-pad bs-coming-soon">
        <div className="bs-coming-soon-icon" aria-hidden="true">{icon}</div>
        <h2>Coming soon</h2>
        <p>
          This section is part of the Bank Statement analysis workspace and will
          be built in a later phase, once real statement parsing is in place.
        </p>
        <span className="badge bs-chip-neutral">
          <span className="dot" />
          Planned
        </span>
      </div>
    </div>
  );
}
