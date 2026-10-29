import { useStore } from '../store';
import { isXrBusy } from '../store/slices/xrSlice';
import { SAMPLE_ASSETS } from '../constants/sampleAssets';
import './SamplePicker.css';

/**
 * The bundled-sample list.
 *
 * One component in two places — the empty state and the Scene tab — because
 * both must offer the same four files through the same guarded load. A separate
 * "demo loader" is exactly how a second parse path, and then a second set of
 * load bugs, gets introduced.
 *
 * Every entry routes through `requestLoadSample`, so the modified-clip discard
 * dialog applies to a sample just as it does to an imported file.
 */
export function SamplePicker({ variant = 'card' }: { variant?: 'card' | 'dock' }) {
  const requestLoadSample = useStore((s) => s.requestLoadSample);
  const activeSampleId = useStore((s) => s.activeSampleId);
  const isLoading = useStore((s) => s.loading.isLoading);
  // Switching the subject under a live session would place the new rig where
  // the old one stood. The session ends on an asset change regardless; this
  // keeps the ordinary path from being the thing that triggers it.
  const xrBusy = useStore((s) => isXrBusy(s.xrPhase));

  return (
    <ul className={`sample-picker sample-picker-${variant}`}>
      {SAMPLE_ASSETS.map((sample) => {
        const active = sample.id === activeSampleId;
        return (
          <li key={sample.id}>
            <button
              className={`sample-btn ${active ? 'is-active' : ''}`}
              onClick={() => void requestLoadSample(sample.id)}
              // Serialised rather than disabled-and-forgotten: the button comes
              // back as soon as the load settles, including when it fails.
              disabled={isLoading || xrBusy}
              aria-current={active ? 'true' : undefined}
            >
              <span className="sample-label">{sample.label}</span>
              <span className="sample-desc">{sample.description}</span>
              <span className="sample-meta">{sample.seconds}s</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
