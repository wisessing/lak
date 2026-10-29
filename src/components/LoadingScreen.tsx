import './LoadingScreen.css';

interface LoadingScreenProps {
  isLoading: boolean;
  progress: number;
}

/** Blocking load indicator. `role="status"` so it is announced, not silent. */
export function LoadingScreen({ isLoading, progress }: LoadingScreenProps) {
  if (!isLoading) return null;

  const pct = Math.round(progress);

  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-card">
        <div className="spinner" />
        <h3>Loading motion data</h3>
        <div
          className="progress-track"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="progress-text mono">{pct}%</span>
      </div>
    </div>
  );
}
