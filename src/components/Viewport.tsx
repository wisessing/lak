import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useStore } from '../store';
import { isXrBusy } from '../store/slices/xrSlice';
import { FolderOpenIcon } from './icons';
import { NavigationHelp } from './NavigationHelp';
import { SamplePicker } from './SamplePicker';
import './Viewport.css';

/**
 * The viewport frame: hosts the 3D canvas, accepts a file dropped anywhere on
 * it, and shows the empty state when nothing is loaded.
 *
 * Drop used to be confined to a small card in the sidebar; the whole viewport
 * is the obvious target.
 */

const EXTENSIONS = ['.fbx', '.glb'];

function isSupported(name: string) {
  const lower = name.toLowerCase();
  return EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function Viewport({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState(false);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestLoadFile = useStore((s) => s.requestLoadFile);
  const setToast = useStore((s) => s.setToast);
  const hasModel = useStore((s) => s.model !== null);
  const isLoading = useStore((s) => s.loading.isLoading);
  const navHelpOpen = useStore((s) => s.navHelpOpen);
  const setNavHelpOpen = useStore((s) => s.setNavHelpOpen);

  const accept = (file: File | undefined) => {
    if (!file) return;
    if (!isSupported(file.name)) {
      setToast(`${file.name} is not an FBX or GLB file.`, 'error');
      return;
    }
    requestLoadFile(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    // Not during a session: a dropped file is an asset swap, and an asset swap
    // ends the session. The drop is simply not an entry point while presenting.
    if (isXrBusy(useStore.getState().xrPhase)) return;
    accept(e.dataTransfer.files?.[0]);
  };

  return (
    <div
      className={`viewport ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!isXrBusy(useStore.getState().xrPhase)) setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the viewport, not when it
        // crosses into a child element.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {children}

      {!hasModel && !isLoading && (
        <div className="viewport-empty">
          <input
            ref={inputRef}
            type="file"
            accept={EXTENSIONS.join(',')}
            hidden
            onChange={(e) => {
              accept(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div className="empty-card">
            <FolderOpenIcon size={28} />
            <h3>Drop a motion file here</h3>
            <p className="hint">FBX or GLB, with a skeleton and an animation clip.</p>
            <div className="empty-actions">
              <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
                Browse files
              </button>
              {/* Nothing external is needed to see the app work: the four
                  samples ship with it. */}
              <button
                className="btn"
                onClick={() => setSamplesOpen((open) => !open)}
                aria-expanded={samplesOpen}
              >
                Try a sample
              </button>
            </div>

            {samplesOpen && <SamplePicker variant="card" />}

            <div className="empty-help">
              {navHelpOpen ? (
                <NavigationHelp onDismiss={() => setNavHelpOpen(false)} />
              ) : (
                <button className="btn btn-ghost" onClick={() => setNavHelpOpen(true)}>
                  Show camera help
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="viewport-dropzone">
          <span>Drop to open</span>
        </div>
      )}
    </div>
  );
}
