import { useRef } from 'react';
import { useStore } from '../store';
import { isXrBusy } from '../store/slices/xrSlice';
import { getIsModified } from '../store/derive';
import { useTheme } from '../hooks/useTheme';
import { useIsPortrait } from '../hooks/useNarrowLayout';
import { ExportIcon, HeadsetIcon, ImportIcon, KeyboardIcon, MenuIcon, MoonIcon, SunIcon } from './icons';
import './TopBar.css';

/** Files the app can open. `.gltf` is excluded: it needs sidecar buffers. */
const ACCEPT = '.fbx,.glb';

interface TopBarProps {
  onShowShortcuts: () => void;
  /** Start a handheld AR session. Absent where the device cannot. */
  onEnterAR?: (() => void) | null;
  /** Narrow layouts render the dock as a drawer, so it needs a toggle here. */
  narrow: boolean;
}

/**
 * The application toolbar: identity, the two file operations, view preferences.
 *
 * **Import and Export are the only file actions, and the only things here.**
 * There used to be a "Save" button, which was a misnomer: it applied a pending
 * trim to the in-session clip and never touched disk. Applying an edit belongs
 * with the edit — it lives on the trim row of the timeline.
 */
/**
 * Entry into a handheld AR session.
 *
 * Gated, with the reason visible rather than a dead control. There must be a
 * subject and a bake to place, and entering mid-edit would strand a trim the
 * user has not decided about: closing the trim tool is not a decision to apply
 * or discard it.
 *
 * `onClick` calls straight through. `requestSession` needs transient user
 * activation, and anything awaited between the tap and the request spends it.
 */
function EnterARButton({ onEnter }: { onEnter: () => void }) {
  const hasModel = useStore((s) => s.model !== null);
  const hasMotion = useStore((s) => s.motion !== null);
  const isLoading = useStore((s) => s.loading.isLoading);
  const trimMode = useStore((s) => s.trimMode);
  const dialog = useStore((s) => s.dialog);
  const phase = useStore((s) => s.xrPhase);
  const setToast = useStore((s) => s.setToast);
  const portrait = useIsPortrait();

  const blocked =
    !hasModel || !hasMotion
      ? 'Load a motion file first'
      : isLoading
        ? 'Wait for the file to finish loading'
        : trimMode
          ? 'Close the trim tool before entering AR'
          : dialog
            ? 'Close the open dialog first'
            : null;
  // AR runs upright and cannot be turned once it starts, so it is entered
  // upright. This is the one lever that works on devices whose browser will
  // not lock orientation for us. The control stays tappable in landscape,
  // because a disabled button's title never shows on a touch screen: the tap
  // is where the user learns to turn the tablet.
  const sideways = blocked === null && !portrait;
  const busy = phase === 'requesting' || phase === 'active' || phase === 'ending';

  return (
    <button
      className="btn btn-ghost"
      onClick={sideways ? () => setToast('Turn the tablet upright to use AR Mode') : onEnter}
      disabled={blocked !== null || busy}
      aria-disabled={sideways || undefined}
      title={blocked ?? (sideways ? 'Turn the tablet upright to use AR Mode' : 'Show the subject in the room around you')}
      aria-label="AR Mode"
    >
      {/* A headset before the words, like Import and Export;
          on a phone the words give way and the headset stands alone. */}
      <HeadsetIcon className="topbar-ar-icon" />
      <span className="topbar-label">{busy ? 'In AR…' : 'AR Mode'}</span>
    </button>
  );
}

export function TopBar({ onShowShortcuts, onEnterAR, narrow }: TopBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { theme, toggleTheme } = useTheme();

  const requestLoadFile = useStore((s) => s.requestLoadFile);
  const hasModel = useStore((s) => s.model !== null);
  const openDialog = useStore((s) => s.openDialog);

  const applied = useStore((s) => s.applied);
  const sourceClip = useStore((s) => s.sourceClip);
  const isModified = getIsModified({ applied, sourceClip });
  const dockOpen = useStore((s) => s.dockOpen);
  const toggleDock = useStore((s) => s.toggleDock);
  const xrBusy = useStore((s) => isXrBusy(s.xrPhase));

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <g stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" fill="none">
            <path d="M8.5 15.5 15.5 8.5" />
            <path d="M7.2 14.2a2.3 2.3 0 1 0-2.5 3.8 2.3 2.3 0 1 0 3.8-2.5" />
            <path d="M16.8 9.8a2.3 2.3 0 1 0 2.5-3.8 2.3 2.3 0 1 0-3.8 2.5" />
          </g>
        </svg>
        <span>LAK</span>
      </div>

      <div className="topbar-actions">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            // A picker opened before the session started can still deliver.
            if (file && !isXrBusy(useStore.getState().xrPhase)) requestLoadFile(file);
            // Reset so re-picking the same file fires change again.
            e.target.value = '';
          }}
        />
        <button
          className="btn btn-ghost"
          disabled={xrBusy}
          title={xrBusy ? 'Leave AR to import a file' : undefined}
          onClick={() => inputRef.current?.click()}
        >
          <ImportIcon />
          <span className="topbar-label">Import</span>
        </button>
        <button
          className="btn btn-ghost"
          disabled={!hasModel || xrBusy}
          title={xrBusy ? 'Leave AR to export' : undefined}
          onClick={() => openDialog({ kind: 'export' })}
        >
          <ExportIcon />
          <span className="topbar-label">Export…</span>
        </button>
        {onEnterAR && <EnterARButton onEnter={onEnterAR} />}
        {isModified && <span className="topbar-modified">edited</span>}
      </div>

      <div className="topbar-right">
        {narrow && (
          <button
            className={`btn-icon ${dockOpen ? 'is-active' : ''}`}
            onClick={toggleDock}
            aria-label={dockOpen ? 'Close panel' : 'Open panel'}
            aria-expanded={dockOpen}
            title="Scene and display panel"
          >
            <MenuIcon />
          </button>
        )}
        <button className="btn-icon" onClick={onShowShortcuts} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          <KeyboardIcon />
        </button>
        <button
          className="btn-icon"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to studio grey' : 'Switch to dark'}
          title={theme === 'dark' ? 'Studio grey viewport' : 'Dark viewport'}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}
