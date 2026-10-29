import './NavigationHelp.css';

/**
 * How to move the camera, stated in full rather than hidden behind a hover.
 *
 * The UX review found the navigation gestures were discoverable only by trying
 * them, and a `title` tooltip does not exist on a touch device at all. These
 * lines describe the actual bindings of the stock OrbitControls rig in
 * `useCameraRig`: they are not aspirational.
 */
const GESTURES: { touch: string; pointer: string; action: string }[] = [
  { action: 'Orbit', touch: 'Drag one finger', pointer: 'Drag with the left button' },
  { action: 'Zoom', touch: 'Pinch two fingers', pointer: 'Scroll the wheel' },
  { action: 'Pan', touch: 'Drag two fingers', pointer: 'Drag with the right button' },
];

export function NavigationHelp({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <div className="nav-help">
      <div className="nav-help-head">
        <span className="section-label">Moving the camera</span>
        {onDismiss && (
          <button className="btn-icon" onClick={onDismiss} aria-label="Hide camera help">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none"
                 stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </div>
      <dl className="nav-help-list">
        {GESTURES.map((g) => (
          <div className="nav-help-row" key={g.action}>
            <dt>{g.action}</dt>
            <dd>
              {g.touch}
              <em> · {g.pointer}</em>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
