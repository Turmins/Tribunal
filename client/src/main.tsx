import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createCase, getCase, getCases, getPanels, type Indictment } from "./api.js";
import { caseLabel, historyLabel } from "./labels.js";
import "./styles.css";

const queryClient = new QueryClient();
const isTerminal = (status: string) => ["completed", "partial", "failed", "cancelled"].includes(status);
const usePanels = () => useQuery({ queryKey: ["panels"], queryFn: getPanels, staleTime: Infinity });
const panelTitle = (items: any[] | undefined, name: string | null | undefined) =>
  items?.find((panel: any) => panel.name === name)?.title ?? null;

function Verdict({ item, index }: { item: any; index: number }) {
  if (item.status === "failed" || item.status === "aborted") {
    return (
      <article className="verdict failed">
        <p className="judge">Judge {index + 1}</p>
        <p className="lens">{item.lens_label}</p>
        <h3>Decision unavailable</h3>
        <p>{item.error?.message ?? "The model call failed."}</p>
      </article>
    );
  }
  if (item.status !== "succeeded") {
    return (
      <article className="verdict pending">
        <p className="judge">Judge {index + 1}</p>
        <p className="lens">{item.lens_label}</p>
        <h3>Awaiting decision</h3>
      </article>
    );
  }
  return (
    <article className="verdict">
      <p className="judge">Judge {index + 1}</p>
      <p className="lens">{item.lens_label}</p>
      <h3 className={item.verdict.decision}>
        {item.verdict.decision === "justified" ? "Justified" : "Not justified"}
      </h3>
      <p>{item.verdict.reasoning}</p>
    </article>
  );
}

function CaseView({ id }: { id: string }) {
  const panels = usePanels();
  const query = useQuery({
    queryKey: ["case", id],
    queryFn: () => getCase(id),
    refetchInterval: state => state.state.data && !isTerminal(state.state.data.status) ? 1000 : false,
  });
  if (query.isLoading) {
    return <section className="status">Case accepted. Preparing four independent arguments…</section>;
  }
  if (query.isError) return <section className="status error">Unable to load the case status.</section>;

  const currentCase = query.data;
  const label = caseLabel(currentCase);
  const title = panelTitle(panels.data?.items, currentCase.panel);
  return (
    <section className="results">
      <p className="eyebrow">{label}{title ? ` · ${title}` : ""}</p>
      <h2>{currentCase.indictment.question}</h2>
      <p className="muted">
        Three judges examine the case through different lenses. Disagreement is evidence for your decision, not a system failure.
      </p>
      <div className="verdict-grid">
        {currentCase.judges.map((judge: any, index: number) => (
          <Verdict key={judge.slot} item={judge} index={index} />
        ))}
      </div>
      <details>
        <summary>Advocate arguments</summary>
        {currentCase.advocates.map((advocate: any, index: number) => (
          <article className="argument" key={advocate.slot}>
            <h4>Advocate {index + 1} · {advocate.assigned_stance === "justified" ? "for" : "against"}</h4>
            <p className="lens">{advocate.lens_label}</p>
            <p>{advocate.argument?.reasoning ?? (advocate.error ? "Argument unavailable." : "Waiting…")}</p>
          </article>
        ))}
      </details>
      <p className="audit">
        Spent ${currentCase.totals.cost_usd.toFixed(4)} of the ${currentCase.totals.budget_usd.toFixed(2)} limit.
        Decisions are never merged; the final conclusion is yours.
      </p>
    </section>
  );
}

function Form({ onCreated }: { onCreated: (id: string) => void }) {
  const [form, setForm] = useState<Indictment>({ defendant: "", act: "", question: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState("");
  const panels = usePanels();
  const options: any[] = panels.data?.items ?? [];
  const chosen = options.find((option: any) => option.name === panel) ?? options[0];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      onCreated((await createCase(form, chosen?.name)).case_id);
    } catch (requestError: any) {
      setError(requestError?.error?.message ?? "Please check the form fields.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="builder">
      <span className="section-number">01</span>
      <div>
        <h2>Draft the indictment</h2>
        <p className="muted">
          This text will be sent to an external model provider. Do not include unnecessary personal information.
        </p>
        <form onSubmit={submit}>
          <label>
            Defendant
            <input required minLength={2} maxLength={200} value={form.defendant}
              onChange={event => setForm({ ...form, defendant: event.target.value })} />
          </label>
          <label>
            Act
            <textarea required minLength={10} maxLength={2000} rows={4} value={form.act}
              onChange={event => setForm({ ...form, act: event.target.value })} />
          </label>
          <label>
            Exact binary question
            <input required minLength={5} maxLength={300} value={form.question}
              onChange={event => setForm({ ...form, question: event.target.value })} />
          </label>
          <label>
            Judge panel
            <select value={chosen?.name ?? ""} onChange={event => setPanel(event.target.value)} disabled={!options.length}>
              {options.map((option: any) => <option key={option.name} value={option.name}>{option.title}</option>)}
            </select>
          </label>
          {chosen && (
            <p className="muted panel-summary">
              {chosen.summary} <span className="lens-list">{chosen.lenses.join(" · ")}</span>
            </p>
          )}
          {error && <p className="form-error">{error}</p>}
          <button disabled={busy}>{busy ? "Creating case…" : "Convene the tribunal →"}</button>
        </form>
      </div>
    </section>
  );
}

function History({ open }: { open: (id: string) => void }) {
  const panels = usePanels();
  const query = useQuery({ queryKey: ["cases"], queryFn: getCases });
  return (
    <section className="history">
      <h2>Previous cases</h2>
      {query.data?.items?.length ? query.data.items.map((item: any) => (
        <button className="case-row" key={item.case_id} onClick={() => open(item.case_id)}>
          <strong>{item.indictment_preview.question}</strong>
          <span>
            {item.indictment_preview.defendant} · {item.status}
            {panelTitle(panels.data?.items, item.panel) ? ` · ${panelTitle(panels.data?.items, item.panel)}` : ""}
          </span>
        </button>
      )) : (
        <p className={query.isError ? "form-error" : "muted"}>
          {historyLabel({ isSuccess: query.isSuccess, isError: query.isError })}
        </p>
      )}
    </section>
  );
}

function App() {
  const [id, setId] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  return (
    <>
      <header>
        <button className="brand" onClick={() => { setId(null); setHistory(false); }}>TRIBUNAL</button>
        <button className="text" onClick={() => setHistory(!history)}>Previous cases</button>
      </header>
      <main>
        <section className="hero">
          <p className="eyebrow">4 advocates · 3 independent judges</p>
          <h1>Examine a difficult decision<br />from multiple perspectives.</h1>
          <p>Tribunal does not choose a winner or reduce the decisions to a single answer.</p>
        </section>
        {history
          ? <History open={caseId => { setId(caseId); setHistory(false); }} />
          : <><Form onCreated={setId} />{id && <CaseView id={id} />}</>}
      </main>
      <footer>A tool for reflection, not professional advice.</footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}><App /></QueryClientProvider>,
);
