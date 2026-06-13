import { useEffect, useState } from "react";

interface PerfStat {
  type: string; count: number; p50: number; p95: number; min: number; max: number;
}
interface SlowRoute {
  ts: number; path: string; ms: number; status: number;
}
interface AnomalyCount { type: string; count: number; }
interface WhisperWarning { ts: number; message: string; mediaId?: string; }
interface HealthSummary {
  perfStats: PerfStat[];
  slowestRoutes: SlowRoute[];
  anomalyCounts: AnomalyCount[];
  whisperWarnings: WhisperWarning[];
  windowMs: number;
}

function bar(val: number, max: number, width = 10): string {
  if (max === 0) return " ".repeat(width);
  const filled = Math.round((val / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function HealthRoute() {
  const [data, setData] = useState<HealthSummary | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health/summary")
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((d) => setData(d as HealthSummary))
      .catch((e) => setFetchErr(String(e)));
  }, []);

  if (fetchErr) return <div className="health-page"><span className="health-err">error: {fetchErr}</span></div>;
  if (!data) return <div className="health-page"><span className="health-loading">loading…</span></div>;

  const maxP95 = Math.max(1, ...data.perfStats.map((s) => s.p95));

  return (
    <div className="health-page">
      <h2 className="health-title">health · last 24h</h2>

      <section className="health-section">
        <h3 className="health-section-title">perf stats</h3>
        {data.perfStats.length === 0
          ? <div className="health-empty">no data</div>
          : (
          <table className="health-table">
            <thead><tr>
              <th>type</th><th>n</th><th>p50</th><th>p95</th><th>min</th><th>max</th><th>p95 bar</th>
            </tr></thead>
            <tbody>
              {data.perfStats.map((s) => (
                <tr key={s.type}>
                  <td className="health-type">{s.type}</td>
                  <td>{s.count}</td>
                  <td>{fmt(s.p50)}</td>
                  <td>{fmt(s.p95)}</td>
                  <td>{fmt(s.min)}</td>
                  <td>{fmt(s.max)}</td>
                  <td className="health-bar">{bar(s.p95, maxP95)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="health-section">
        <h3 className="health-section-title">slowest routes</h3>
        {data.slowestRoutes.length === 0
          ? <div className="health-empty">no data</div>
          : (
          <table className="health-table">
            <thead><tr><th>path</th><th>ms</th><th>status</th><th>time</th></tr></thead>
            <tbody>
              {data.slowestRoutes.map((r, i) => (
                <tr key={i}>
                  <td className="health-type">{r.path}</td>
                  <td className={r.ms > 1000 ? "health-warn" : ""}>{fmt(r.ms)}</td>
                  <td className={r.status >= 500 ? "health-err" : ""}>{r.status}</td>
                  <td>{fmtTs(r.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="health-section">
        <h3 className="health-section-title">anomalies</h3>
        {data.anomalyCounts.length === 0
          ? <div className="health-empty">none</div>
          : (
          <table className="health-table">
            <thead><tr><th>type</th><th>count</th></tr></thead>
            <tbody>
              {data.anomalyCounts.map((a) => (
                <tr key={a.type}>
                  <td className="health-type">{a.type}</td>
                  <td className="health-warn">{a.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="health-section">
        <h3 className="health-section-title">whisper warnings</h3>
        {data.whisperWarnings.length === 0
          ? <div className="health-empty">none</div>
          : (
          <table className="health-table">
            <thead><tr><th>time</th><th>media</th><th>message</th></tr></thead>
            <tbody>
              {data.whisperWarnings.map((w, i) => (
                <tr key={i}>
                  <td>{fmtTs(w.ts)}</td>
                  <td>{w.mediaId ?? "—"}</td>
                  <td className="health-type">{w.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
