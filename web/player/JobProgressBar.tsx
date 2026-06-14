// Bottom `.controls` row surfacing long-running job progress (translate /
// condense / whisper). Pure presentation — busy flags, status and the cancel
// callback live in Player.tsx (useWhisperJob). Extracted from Player.tsx.

import { fmtTime } from "./shared.ts";

export function JobProgressBar({
  translateBusy,
  condenseBusy,
  whisperBusy,
  whisperLastEnd,
  whisperStatus,
  videoDuration,
  onCancelWhisper,
}: {
  translateBusy: boolean;
  condenseBusy: boolean;
  whisperBusy: boolean;
  whisperLastEnd: number;
  whisperStatus: string;
  videoDuration: number;
  onCancelWhisper: () => void;
}) {
  const whisperPct =
    videoDuration > 0
      ? Math.min(100, (whisperLastEnd / videoDuration) * 100)
      : 0;
  return (
    <div className="controls">
      {translateBusy && <span className="spinner-line">Translating…</span>}
      {condenseBusy && <span className="spinner-line">Condensing audio…</span>}
      {whisperBusy && (
        <>
          <div className="whisper-progress" title="Whisper transcription progress">
            <span className="spinner-line">
              Generating ja subs… {fmtTime(whisperLastEnd)}
              {videoDuration > 0 ? ` / ${fmtTime(videoDuration)}` : ""}
              {whisperStatus && whisperStatus !== "running" ? ` (${whisperStatus})` : ""}
            </span>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={videoDuration > 0 ? Math.round(whisperPct) : undefined}
              aria-valuetext={
                videoDuration > 0 ? `${Math.round(whisperPct)}%` : undefined
              }
              aria-label="Whisper transcription progress"
            >
              <div
                className="progress-fill"
                style={{ width: `${whisperPct}%` }}
              />
            </div>
          </div>
          <button className="btn sm" onClick={onCancelWhisper} title="Stop transcription">
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
