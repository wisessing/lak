import { useStore } from '../store';
import { getIsModified } from '../store/derive';
import './StatusBar.css';

/**
 * The status strip: what is loaded, and how the app is doing with it.
 *
 * Deliberately selects no playhead field — it must not re-render during
 * playback. The FPS readout was computed and thrown away before this existed.
 */
export function StatusBar() {
  const fileName = useStore((s) => s.fileName);
  const sourceFormat = useStore((s) => s.sourceFormat);
  const boneCount = useStore((s) => s.skeleton?.boneCount ?? 0);
  const motionFrames = useStore((s) => s.motion?.frameCount ?? 0);
  const sampleFps = useStore((s) => s.motion?.fps ?? 0);
  const duration = useStore((s) => s.duration);
  const fps = useStore((s) => s.rendererFps);

  const applied = useStore((s) => s.applied);
  const sourceClip = useStore((s) => s.sourceClip);
  const isModified = getIsModified({ applied, sourceClip });

  return (
    <footer className="statusbar">
      <span className="status-file">
        {fileName ? (
          <>
            {fileName}
            {sourceFormat && <em className="status-badge">{sourceFormat.toUpperCase()}</em>}
          </>
        ) : (
          <em className="status-empty">No file loaded</em>
        )}
      </span>

      {boneCount > 0 && <span className="status-item">{boneCount} bones</span>}
      {motionFrames > 0 && (
        <span className="status-item mono">
          {motionFrames} frames @ {sampleFps}fps
        </span>
      )}
      {duration > 0 && <span className="status-item mono">{duration.toFixed(2)}s</span>}

      {isModified && (
        <span className="status-modified" title="The clip has been edited in this session">
          edited
        </span>
      )}

      <span className="status-spacer" />
      {fps > 0 && <span className="status-item mono">{fps} fps</span>}
    </footer>
  );
}
