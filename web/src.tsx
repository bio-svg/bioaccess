import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Row = Record<string, any>;
type User = { id: string; name: string; email: string; role: string };
let csrf = "";
const reasons: Record<string, string> = {
  authentication_required: "Sign in to continue.",
  invalid_credentials: "Incorrect email or password.",
  session_expired: "Your session has expired. Please sign in again.",
  project_membership_required:
    "You do not have an active membership in this project.",
  grant_required: "You need an approved grant to query this dataset.",
  grant_revoked: "Access has been revoked. Future operations are blocked.",
  grant_expired: "Your grant has expired. Request renewed access.",
  operation_not_granted: "Your grant does not include this operation.",
  valid_unused_export_approval_required:
    "The approval does not match these filters, has expired, or has already been used.",
  reviewer_required: "This action requires a project reviewer.",
  admin_required: "This action requires an administrator.",
  tool_outside_scope:
    "Tool blocked: the assistant cannot execute SQL, commands, or arbitrary URL requests.",
  assistant_session_invalid_or_limit:
    "This conversation has reached its 20-message limit or is no longer available. Start a new one.",
  invalid_input: "Check the fields and filters you entered.",
  request_already_pending:
    "There is already a pending access request for this dataset.",
  cannot_review_own_request: "You cannot approve your own access request.",
  cannot_review_own_export: "You cannot approve your own export request.",
  operation_failed:
    "The operation could not be completed. Check your input or try again.",
};
async function api(path: string, body?: unknown) {
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error("The server did not return a valid response.");
  }
  if (!r.ok)
    throw Error(
      (reasons[data.error] ?? data.error ?? "Operation blocked") +
        (data.correlation ? ` · Ref. ${data.correlation.slice(0, 8)}` : ""),
    );
  return data;
}
function saveJSON(data: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const date = (v: any) =>
  v
    ? new Date(v).toLocaleString("en-US", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
const labels: Record<string, string> = {
  researcher: "Researcher",
  reviewer: "Reviewer",
  admin: "Administrator",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  allow: "Allowed",
  deny: "Blocked",
};
function Badge({ value }: { value: string }) {
  return <span className={"badge " + value}>{labels[value] ?? value}</span>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <span>◇</span>
      <p>{children}</p>
    </div>
  );
}
function Records({ rows }: { rows: Row[] }) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fictional sample</th>
            <th>Site</th>
            <th>Measurement</th>
            <th>Untrusted note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.id}</td>
              <td>{r.site}</td>
              <td>
                {r.value} <small>{r.unit}</small>
              </td>
              <td className="note">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>No records were returned.</Empty>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [initial, setInitial] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState("");
  const [email, setEmail] = useState("researcher@bioaccess.test"),
    [password, setPassword] = useState("");
  const [projects, setProjects] = useState<Row[]>([]),
    [project, setProject] = useState(""),
    [datasets, setDatasets] = useState<Row[]>([]),
    [dataset, setDataset] = useState(""),
    [tab, setTab] = useState("catalog");
  const [overview, setOverview] = useState<{
    access: Row[];
    exports: Row[];
    grants: Row[];
  }>({ access: [], exports: [], grants: [] });
  const [requesting, setRequesting] = useState(""),
    [reason, setReason] = useState(""),
    [ops, setOps] = useState(["read", "summary"]);
  const [site, setSite] = useState(""),
    [min, setMin] = useState(""),
    [max, setMax] = useState(""),
    [limit, setLimit] = useState(20),
    [result, setResult] = useState<Row | null>(null);
  const [conversation, setConversation] = useState(""),
    [messages, setMessages] = useState<{ speaker: string; data: any }[]>([]),
    [message, setMessage] = useState("");
  const [audit, setAudit] = useState<Row[]>([]),
    [outcome, setOutcome] = useState(""),
    [action, setAction] = useState(""),
    [actor, setActor] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [reports, setReports] = useState<Row[]>([]),
    [admin, setAdmin] = useState<Row | null>(null);
  const [newUser, setNewUser] = useState({
      name: "",
      email: "",
      password: "",
      role: "researcher",
    }),
    [newProject, setNewProject] = useState({ name: "", description: "" }),
    [newDataset, setNewDataset] = useState({
      name: "",
      description: "Exclusively fictional data.",
    }),
    [member, setMember] = useState({ user: "", active: true });
  const prefix = `/projects/${project}`;
  const review = user?.role === "reviewer" || user?.role === "admin";
  const f = {
    ...(site ? { site } : {}),
    ...(min !== "" ? { min: Number(min) } : {}),
    ...(max !== "" ? { max: Number(max) } : {}),
    limit,
  };
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setToast("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadProject(id: string) {
    const [d, o] = await Promise.all([
      api(`/projects/${id}/datasets`),
      api(`/projects/${id}/requests`),
    ]);
    setDatasets(d);
    setDataset(d[0]?.id ?? "");
    setOverview(o);
  }
  async function refresh() {
    if (project) {
      const [d, o] = await Promise.all([
        api(prefix + "/datasets"),
        api(prefix + "/requests"),
      ]);
      setDatasets(d);
      setOverview(o);
    }
  }
  async function loadProjects() {
    const p = await api("/projects");
    setProjects(p);
    setProject(p[0]?.id ?? "");
  }
  useEffect(() => {
    api("/me")
      .then((d) => {
        csrf = d.csrf;
        setUser(d.user);
      })
      .catch(() => {})
      .finally(() => setInitial(false));
  }, []);
  useEffect(() => {
    if (user) void task(loadProjects);
  }, [user?.id]);
  useEffect(() => {
    setDatasets([]);
    setDataset("");
    setResult(null);
    setMessages([]);
    setConversation("");
    setAudit([]);
    setRequesting("");
    setOverview({ access: [], exports: [], grants: [] });
    if (project) void task(() => loadProject(project));
  }, [project]);
  useEffect(() => {
    if (!user) return;
    if (tab === "evaluation")
      void task(async () => setReports(await api("/evaluations")));
    if (tab === "admin") void task(async () => setAdmin(await api("/admin")));
  }, [tab]);
  if (initial) return <div className="boot">BioAccess · Loading session…</div>;
  if (!user)
    return (
      <div className="login-shell">
        <section className="login-story">
          <div className="wordmark">
            <span className="logo">B</span> BioAccess
          </div>
          <div className="eyebrow">RESEARCH · DELEGATED ACCESS</div>
          <h1>
            Share data.
            <br />
            <em>Keep control.</em>
          </h1>
          <p>
            Precise permissions for researchers and assistants. Every decision
            visible. Every access verified.
          </p>
          <div className="orbit">
            <i />
            <i />
            <i />
            <span>
              ACCESS
              <br />
              WITH PURPOSE
            </span>
          </div>
          <small>LOCAL PROTOTYPE / 100% FICTIONAL DATA</small>
        </section>
        <main className="login-form">
          <span className="eyebrow">YOUR RESEARCH WORKSPACE</span>
          <h2>Welcome to BioAccess</h2>
          <p className="muted">
            Sign in with an account from the demo environment.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task(async () => {
                const d = await api("/login", { email, password });
                csrf = d.csrf;
                setPassword("");
                setUser(d.user);
              });
            }}
          >
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && (
              <div role="alert" className="alert">
                {error}
              </div>
            )}
            <button className="primary wide" disabled={busy}>
              {busy ? "Signing in…" : "Enter workspace →"}
            </button>
          </form>
          <div className="info">
            <strong>Development environment</strong>
            <p>
              Accounts and passwords are configured by the local development
              seed. See the README. Do not use personal credentials.
            </p>
          </div>
        </main>
      </div>
    );
  const tabs = [
    ["catalog", "◈", "Catalog"],
    ["explore", "▦", "Explorer"],
    ["assistant", "✳", "Assistant"],
    ["requests", "◎", "Requests"],
    ...(review
      ? [
          ["audit", "≡", "Audit log"],
          ["evaluation", "⌁", "Evaluation"],
        ]
      : []),
    ...(user.role === "admin" ? [["admin", "⚙", "Administration"]] : []),
  ];
  const title = tabs.find((t) => t[0] === tab)?.[2] ?? "Catalog";
  const selected = datasets.find((d) => d.id === dataset);
  const selector = (
    <label>
      Dataset
      <select
        value={dataset}
        onChange={(e) => {
          setDataset(e.target.value);
          setResult(null);
        }}
      >
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="wordmark">
          <span className="logo">B</span> BioAccess
        </div>
        <span className="sidebar-label">WORKSPACE</span>
        <nav>
          {tabs.map(([id, icon, name]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
                setError("");
              }}
            >
              <span aria-hidden="true">{icon}</span>
              {name}
              {id === "requests" &&
                overview.access.filter((r) => r.status === "pending").length >
                  0 && (
                  <b>
                    {
                      overview.access.filter((r) => r.status === "pending")
                        .length
                    }
                  </b>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" /> Local environment
          <p>
            Fictional data only.
            <br />
            Simulated assistant.
          </p>
        </div>
        <div className="identity">
          <div className="avatar">{user.name[0]}</div>
          <div>
            <strong>{user.name}</strong>
            <small>{labels[user.role]}</small>
          </div>
          <button
            title="Sign out"
            aria-label="Sign out"
            onClick={() =>
              void task(async () => {
                await api("/logout", {});
                setUser(null);
                setProject("");
                csrf = "";
              })
            }
          >
            ↗
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Research <span className="slash">/</span> {title}
          </span>
          <label className="project-select">
            <span>ACTIVE PROJECT</span>
            <select
              aria-label="Active project"
              disabled={busy}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                BIOACCESS / {project || "NO MEMBERSHIP"}
              </span>
              <h1>{title}</h1>
              <p className="muted">
                {tab === "catalog"
                  ? "Discover datasets. Request the access your project needs."
                  : tab === "assistant"
                    ? "Scoped tools, always using your permissions."
                    : "Verified operations and traceable decisions."}
              </p>
            </div>
            <span className="demo-stamp">◇ Research prototype</span>
          </div>
          {error && (
            <div className="alert" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {toast && (
            <div className="success" role="status">
              {toast}
            </div>
          )}
          {busy && (
            <div className="loading" role="status">
              Processing operation…
            </div>
          )}
          {!project && tab !== "admin" && (
            <Empty>
              You have no assigned projects. An administrator can add a
              membership.
            </Empty>
          )}
          {project && tab === "catalog" && (
            <>
              <div className="stats">
                <div>
                  <span>Project datasets</span>
                  <strong>{datasets.length.toString().padStart(2, "0")}</strong>
                  <small>Visible metadata</small>
                </div>
                <div>
                  <span>Active grants</span>
                  <strong>
                    {datasets
                      .filter(
                        (d) =>
                          d.operations &&
                          !d.revoked_at &&
                          new Date(d.expires_at) > new Date(),
                      )
                      .length.toString()
                      .padStart(2, "0")}
                  </strong>
                  <small>Checked on every operation</small>
                </div>
                <div>
                  <span>Pending requests</span>
                  <strong>
                    {overview.access
                      .filter((r) => r.status === "pending")
                      .length.toString()
                      .padStart(2, "0")}
                  </strong>
                  <small>Human decision</small>
                </div>
              </div>
              <div className="section-title">
                <h2>Available for research</h2>
                <span className="muted">{datasets.length} datasets</span>
              </div>
              <div className="dataset-grid">
                {datasets.map((d, i) => {
                  const valid =
                    d.operations &&
                    !d.revoked_at &&
                    new Date(d.expires_at) > new Date();
                  return (
                    <article className="dataset-card" key={d.id}>
                      <div className="dataset-top">
                        <div className={"dataset-art art" + i}>
                          <span>▧</span>
                          <i />
                          <i />
                        </div>
                        <Badge value={valid ? "allow" : "Access required"} />
                      </div>
                      <span className="eyebrow">
                        DATASET {String(i + 1).padStart(2, "0")} · FICTIONAL
                      </span>
                      <h2>{d.name}</h2>
                      <p>{d.description}</p>
                      <div className="card-meta">
                        <span>
                          {valid ? d.operations.join(" · ") : "No active grant"}
                        </span>
                        <small>
                          {valid
                            ? `Until ${date(d.expires_at)}`
                            : "Human review required"}
                        </small>
                      </div>
                      <div className="card-actions">
                        <button
                          className={valid ? "primary" : "secondary"}
                          disabled={busy}
                          onClick={() => {
                            if (valid) {
                              setDataset(d.id);
                              setResult(null);
                              setTab("explore");
                            } else {
                              setRequesting(d.id);
                              setReason("");
                            }
                          }}
                        >
                          {valid ? "Explore records →" : "Request access →"}
                        </button>
                        {valid && (
                          <button
                            className="text-button"
                            onClick={() => setRequesting(d.id)}
                          >
                            Update access
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              {datasets.length === 0 && (
                <Empty>There are no datasets in this project.</Empty>
              )}
              {requesting && (
                <section className="panel request-form">
                  <div className="section-title">
                    <h2>
                      Request access ·{" "}
                      {datasets.find((d) => d.id === requesting)?.name}
                    </h2>
                    <button onClick={() => setRequesting("")}>Close</button>
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void task(async () => {
                        await api(`${prefix}/datasets/${requesting}/requests`, {
                          operations: ops,
                          reason,
                        });
                        setRequesting("");
                        await refresh();
                        setToast(
                          "Request submitted. A project reviewer will review your access.",
                        );
                      });
                    }}
                  >
                    <label>
                      Purpose of access
                      <textarea
                        minLength={8}
                        maxLength={500}
                        required
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Explain why you need access to these fictional records…"
                      />
                    </label>
                    <div className="checks">
                      {[
                        ["read", "Query records"],
                        ["summary", "Summarize"],
                        ["export", "Export (requires additional approval)"],
                      ].map(([id, name]) => (
                        <label key={id}>
                          <input
                            type="checkbox"
                            checked={ops.includes(id)}
                            onChange={(e) =>
                              setOps(
                                e.target.checked
                                  ? [...ops, id]
                                  : ops.filter((o) => o !== id),
                              )
                            }
                          />
                          {name}
                        </label>
                      ))}
                    </div>
                    <button
                      className="primary"
                      disabled={busy || ops.length === 0}
                    >
                      Submit request
                    </button>
                  </form>
                </section>
              )}
              <div className="info horizontal">
                <span>◎</span>
                <p>
                  <strong>
                    The catalog does not grant access to dataset contents.
                  </strong>{" "}
                  Permissions are checked for queries, summaries, and exports.
                  Revocation blocks future operations but cannot recover data
                  already downloaded.
                </p>
              </div>
            </>
          )}
          {project && tab === "explore" && (
            <>
              <section className="panel">
                <div className="section-title">
                  <h2>Structured query</h2>
                  <Badge value="Fictional data" />
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void task(async () =>
                      setResult(
                        await api(`${prefix}/datasets/${dataset}/query`, f),
                      ),
                    );
                  }}
                >
                  <div className="filters">
                    {selector}
                    <label>
                      Site
                      <select
                        value={site}
                        onChange={(e) => setSite(e.target.value)}
                      >
                        <option value="">All</option>
                        <option>North</option>
                        <option>South</option>
                      </select>
                    </label>
                    <label>
                      Minimum
                      <input
                        type="number"
                        min={-1000}
                        max={1000}
                        value={min}
                        onChange={(e) => setMin(e.target.value)}
                      />
                    </label>
                    <label>
                      Maximum
                      <input
                        type="number"
                        min={-1000}
                        max={1000}
                        value={max}
                        onChange={(e) => setMax(e.target.value)}
                      />
                    </label>
                    <label>
                      Limit
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={limit}
                        onChange={(e) => setLimit(Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <div className="actions">
                    <button className="primary" disabled={busy || !dataset}>
                      Query →
                    </button>
                    <button
                      type="button"
                      disabled={busy || !dataset}
                      onClick={() =>
                        void task(async () =>
                          setResult(
                            await api(
                              `${prefix}/datasets/${dataset}/summary`,
                              f,
                            ),
                          ),
                        )
                      }
                    >
                      Summarize
                    </button>
                    <button
                      type="button"
                      disabled={busy || !dataset}
                      onClick={() =>
                        void task(async () => {
                          await api(`${prefix}/datasets/${dataset}/exports`, f);
                          await refresh();
                          setToast(
                            "Export requested for these exact filters. Check its status under Requests.",
                          );
                        })
                      }
                    >
                      Request export
                    </button>
                  </div>
                </form>
              </section>
              <section className="panel">
                <h2>{selected?.name ?? "Results"}</h2>
                {result ? (
                  result.records ? (
                    <Records rows={result.records} />
                  ) : (
                    <div className="summary">
                      <strong>{result.count} records</strong>
                      <p>
                        Average: {result.average ?? "No data"} · {result.unit}
                      </p>
                    </div>
                  )
                ) : (
                  <Empty>
                    Select a dataset and run a query. The backend checks your
                    grant before returning records.
                  </Empty>
                )}
              </section>
            </>
          )}
          {project && tab === "assistant" && (
            <div className="chat-layout">
              <section className="panel chat">
                <div className="section-title">
                  <h2>Research assistant</h2>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setConversation("");
                      setMessages([]);
                    }}
                  >
                    New conversation
                  </button>
                </div>
                <div className="simulation">
                  DETERMINISTIC SIMULATION · Not a real model
                </div>
                <div className="messages">
                  {messages.length === 0 && (
                    <Empty>
                      Try ‘list datasets’, ‘query records’, ‘summarize’, or
                      ‘request export’. The simulator uses a maximum of 20
                      records.
                    </Empty>
                  )}
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className={
                        "message " + (m.speaker === "You" ? "human" : "agent")
                      }
                    >
                      <strong>{m.speaker}</strong>
                      {typeof m.data === "string" ? (
                        <p>{m.data}</p>
                      ) : m.data.records ? (
                        <Records rows={m.data.records} />
                      ) : Array.isArray(m.data) ? (
                        <ul>
                          {m.data.map((d: Row) => (
                            <li key={d.id}>
                              {d.name} · {d.id}
                            </li>
                          ))}
                        </ul>
                      ) : m.data.status === "pending" ? (
                        <p>
                          Export request created. A reviewer must approve it;
                          download it from Requests.
                        </p>
                      ) : (
                        <p>
                          {m.data.count} records · average{" "}
                          {m.data.average ?? "no data"}.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = message;
                    setMessage("");
                    setMessages((v) => [...v, { speaker: "You", data: text }]);
                    void task(async () => {
                      let id = conversation;
                      if (!id) {
                        const created = await api(prefix + "/assistant", {});
                        id = created.id;
                        setConversation(id);
                      }
                      try {
                        const d = await api(
                          `${prefix}/assistant/${id}/messages`,
                          { message: text, dataset },
                        );
                        setMessages((v) => [
                          ...v,
                          { speaker: "Assistant · simulation", data: d.result },
                        ]);
                      } catch (e) {
                        setMessages((v) => [
                          ...v,
                          {
                            speaker: "Access control",
                            data: (e as Error).message,
                          },
                        ]);
                        throw e;
                      }
                    });
                  }}
                >
                  {selector}
                  <label>
                    Message
                    <input
                      maxLength={1000}
                      required
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Summarize the authorized records…"
                    />
                  </label>
                  <button className="primary" disabled={busy || !dataset}>
                    Send →
                  </button>
                </form>
              </section>
              <aside className="panel chat-policy">
                <span className="eyebrow">ASSISTANT LIMITS</span>
                <h2>
                  Your permissions.
                  <br />
                  No extra privileges.
                </h2>
                <p>1 tool per message.</p>
                <p>20 messages per conversation.</p>
                <p>No SQL, commands, or arbitrary URLs.</p>
                <p>Revocation also applies to ongoing conversations.</p>
                <div className="info">
                  Dataset text is untrusted data, never an authorization
                  instruction.
                </div>
              </aside>
            </div>
          )}
          {project && tab === "requests" && (
            <>
              <div className="section-title">
                <h2>{review ? "Review queue" : "Your request status"}</h2>
                <button disabled={busy} onClick={() => void task(refresh)}>
                  Refresh
                </button>
              </div>
              <section className="panel">
                <h2>Dataset access</h2>
                {overview.access.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Dataset / applicant</th>
                          <th>Purpose and operations</th>
                          <th>Status</th>
                          <th>Decision</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.access.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <strong>{r.dataset_name}</strong>
                              <small>{r.applicant}</small>
                            </td>
                            <td>
                              {r.reason}
                              <small>{r.operations.join(", ")}</small>
                            </td>
                            <td>
                              <Badge value={r.status} />
                            </td>
                            <td>
                              {review && r.status === "pending" ? (
                                <div className="actions">
                                  <button
                                    disabled={busy}
                                    onClick={() =>
                                      void task(async () => {
                                        await api(
                                          `${prefix}/requests/${r.id}/review`,
                                          { decision: "approved", days: 7 },
                                        );
                                        await refresh();
                                      })
                                    }
                                  >
                                    Approve for 7 days
                                  </button>
                                  <button
                                    className="danger"
                                    disabled={busy}
                                    onClick={() =>
                                      void task(async () => {
                                        await api(
                                          `${prefix}/requests/${r.id}/review`,
                                          { decision: "rejected" },
                                        );
                                        await refresh();
                                      })
                                    }
                                  >
                                    Reject
                                  </button>
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty>No access requests yet.</Empty>
                )}
              </section>
              <section className="panel">
                <h2>Exports · single-use approval</h2>
                {overview.exports.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Dataset / applicant</th>
                          <th>Exact filters</th>
                          <th>Status / expiration</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.exports.map((r) => (
                          <tr key={r.id}>
                            <td>
                              {r.dataset_name}
                              <small>{r.applicant}</small>
                            </td>
                            <td>
                              <code>{JSON.stringify(r.params)}</code>
                            </td>
                            <td>
                              <Badge
                                value={r.consumed_at ? "Consumed" : r.status}
                              />
                              <small>{date(r.expires_at)}</small>
                            </td>
                            <td>
                              <div className="actions">
                                {review &&
                                  r.status === "pending" &&
                                  (["approved", "rejected"] as const).map(
                                    (decision) => (
                                      <button
                                        key={decision}
                                        disabled={busy}
                                        onClick={() =>
                                          void task(async () => {
                                            await api(
                                              `${prefix}/exports/${r.id}/review`,
                                              { decision },
                                            );
                                            await refresh();
                                          })
                                        }
                                      >
                                        {decision === "approved"
                                          ? "Approve for 15 min"
                                          : "Reject"}
                                      </button>
                                    ),
                                  )}
                                {r.user_id === user.id &&
                                  r.status === "approved" &&
                                  !r.consumed_at && (
                                    <button
                                      disabled={
                                        busy ||
                                        new Date(r.expires_at) < new Date()
                                      }
                                      onClick={() =>
                                        void task(async () => {
                                          const d = await api(
                                            `${prefix}/datasets/${r.dataset_id}/exports/${r.id}/download`,
                                            r.params,
                                          );
                                          saveJSON(
                                            d,
                                            "bioaccess-fictional-data.json",
                                          );
                                          await refresh();
                                        })
                                      }
                                    >
                                      Download JSON
                                    </button>
                                  )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty>No export requests yet.</Empty>
                )}
              </section>
              <section className="panel">
                <h2>Granted permissions</h2>
                {overview.grants.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Person / dataset</th>
                          <th>Operations</th>
                          <th>Expiration</th>
                          <th>Control</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.grants.map((g) => (
                          <tr key={g.id}>
                            <td>
                              {g.applicant}
                              <small>{g.dataset_name}</small>
                            </td>
                            <td>{g.operations.join(", ")}</td>
                            <td>
                              {g.revoked_at ? "Revoked" : date(g.expires_at)}
                            </td>
                            <td>
                              {review && !g.revoked_at && (
                                <button
                                  className="danger"
                                  disabled={busy}
                                  onClick={() =>
                                    void task(async () => {
                                      await api(
                                        `${prefix}/grants/${g.id}/revoke`,
                                        {},
                                      );
                                      await refresh();
                                      setToast(
                                        "Access revoked. Previously downloaded files cannot be recovered.",
                                      );
                                    })
                                  }
                                >
                                  Revoke access
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty>No permissions have been granted.</Empty>
                )}
              </section>
            </>
          )}
          {project && tab === "audit" && (
            <section className="panel">
              <h2>Decision log</h2>
              <p className="muted">
                No full dataset contents or credentials. Most recent 200 events
                for this project.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void task(async () => {
                    const q = new URLSearchParams();
                    if (outcome) q.set("outcome", outcome);
                    if (action) q.set("action", action);
                    if (actor) q.set("actor", actor);
                    if (from) q.set("from", new Date(from).toISOString());
                    if (to) q.set("to", new Date(to).toISOString());
                    setAudit(await api(prefix + "/audit?" + q));
                  });
                }}
              >
                <div className="filters">
                  <label>
                    Result
                    <select
                      value={outcome}
                      onChange={(e) => setOutcome(e.target.value)}
                    >
                      <option value="">All</option>
                      <option value="allow">Allowed</option>
                      <option value="deny">Blocked</option>
                    </select>
                  </label>
                  <label>
                    Exact action
                    <input
                      placeholder="records.read"
                      value={action}
                      onChange={(e) => setAction(e.target.value)}
                    />
                  </label>
                  <label>
                    Actor (ID)
                    <input
                      value={actor}
                      onChange={(e) => setActor(e.target.value)}
                    />
                  </label>
                  <label>
                    From
                    <input
                      type="datetime-local"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    Until
                    <input
                      type="datetime-local"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                </div>
                <button className="primary" disabled={busy}>
                  Filter events
                </button>
              </form>
              {audit.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date / actor</th>
                        <th>Operation / dataset</th>
                        <th>Decision / reason</th>
                        <th>Correlation / assistant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.map((r) => (
                        <tr key={r.id}>
                          <td>
                            {date(r.created_at)}
                            <small>{r.actor_id ?? "Unauthenticated"}</small>
                          </td>
                          <td>
                            {r.action}
                            <small>{r.dataset_id ?? "—"}</small>
                          </td>
                          <td>
                            <Badge value={r.outcome} />
                            <small>{r.reason}</small>
                          </td>
                          <td className="mono">
                            {r.correlation_id}
                            <small>
                              {r.assistant_session_id ?? "Direct operation"}
                            </small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>
                  Apply filters to view the audit log. Events cannot be edited
                  or deleted through the app.
                </Empty>
              )}
            </section>
          )}
          {tab === "evaluation" && (
            <>
              <div className="info">
                <strong>
                  Control evaluation, not an assessment of LLM behavior.
                </strong>
                <p>
                  Reproducible scenarios using fictional data. Generate and save
                  a run with <code>npm run evaluate -- --save</code>.
                </p>
              </div>
              {reports.length ? (
                reports.map((r) => (
                  <section key={r.id} className="panel">
                    <div className="section-title">
                      <div>
                        <h2>Run {date(r.created_at)}</h2>
                        <p className="muted">{r.report.engine} · simulation</p>
                      </div>
                      <button
                        onClick={() =>
                          void task(async () =>
                            saveJSON(
                              await api(`/evaluations/${r.id}/report`),
                              "bioaccess-evaluation.json",
                            ),
                          )
                        }
                      >
                        Export JSON report
                      </button>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Scenario</th>
                            <th>Expected / attempted</th>
                            <th>Control</th>
                            <th>Effect and legitimate task</th>
                            <th>Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.report.rows.map((x: Row) => (
                            <tr key={x.scenario}>
                              <td>{x.scenario}</td>
                              <td>
                                {x.expected}
                                <small>{x.attempted}</small>
                              </td>
                              <td>{x.decision}</td>
                              <td>
                                {x.executed}
                                <small>{x.legitimateTask}</small>
                              </td>
                              <td>
                                <Badge value={x.passed ? "allow" : "deny"} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))
              ) : (
                <Empty>
                  No evaluations have been saved yet. Run the command above; the
                  report is also saved to reports/evaluation.json.
                </Empty>
              )}
            </>
          )}
          {tab === "admin" && admin && (
            <>
              <div className="info">
                Administrators manage the environment. They do not automatically
                get dataset access: membership and a grant are still required.
              </div>
              <div className="admin-grid">
                <section className="panel">
                  <h2>Create user</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void task(async () => {
                        await api("/admin/users", newUser);
                        setNewUser({
                          name: "",
                          email: "",
                          password: "",
                          role: "researcher",
                        });
                        setAdmin(await api("/admin"));
                        setToast("User created.");
                      });
                    }}
                  >
                    {(["name", "email", "password"] as const).map((k) => (
                      <label key={k}>
                        {
                          {
                            name: "Name",
                            email: "Email",
                            password: "Initial password (12+ characters)",
                          }[k]
                        }
                        <input
                          type={
                            k === "password"
                              ? "password"
                              : k === "email"
                                ? "email"
                                : "text"
                          }
                          required
                          minLength={k === "password" ? 12 : 2}
                          autoComplete="off"
                          value={newUser[k]}
                          onChange={(e) =>
                            setNewUser({ ...newUser, [k]: e.target.value })
                          }
                        />
                      </label>
                    ))}
                    <label>
                      Role
                      <select
                        value={newUser.role}
                        onChange={(e) =>
                          setNewUser({ ...newUser, role: e.target.value })
                        }
                      >
                        {["researcher", "reviewer", "admin"].map((r) => (
                          <option key={r} value={r}>
                            {labels[r]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button disabled={busy}>Create user</button>
                  </form>
                </section>
                <section className="panel">
                  <h2>Create project</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void task(async () => {
                        await api("/admin/projects", newProject);
                        setNewProject({ name: "", description: "" });
                        setAdmin(await api("/admin"));
                        await loadProjects();
                      });
                    }}
                  >
                    <label>
                      Name
                      <input
                        required
                        minLength={2}
                        value={newProject.name}
                        onChange={(e) =>
                          setNewProject({ ...newProject, name: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Description
                      <textarea
                        value={newProject.description}
                        onChange={(e) =>
                          setNewProject({
                            ...newProject,
                            description: e.target.value,
                          })
                        }
                      />
                    </label>
                    <button disabled={busy}>Create project</button>
                  </form>
                  <h2>Active project membership</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void task(async () => {
                        await api("/admin/memberships", { ...member, project });
                        setAdmin(await api("/admin"));
                        setToast("Membership updated.");
                      });
                    }}
                  >
                    <label>
                      User
                      <select
                        required
                        value={member.user}
                        onChange={(e) =>
                          setMember({ ...member, user: e.target.value })
                        }
                      >
                        <option value="">Choose a user</option>
                        {admin.users.map((u: Row) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={member.active}
                        onChange={(e) =>
                          setMember({ ...member, active: e.target.checked })
                        }
                      />
                      Active membership
                    </label>
                    <button disabled={busy || !project}>Save membership</button>
                  </form>
                </section>
                <section className="panel">
                  <h2>Create fictional dataset</h2>
                  <p className="muted">
                    Creates a harmless demo record in the active project.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void task(async () => {
                        await api("/admin/datasets", {
                          ...newDataset,
                          project,
                        });
                        setNewDataset({
                          name: "",
                          description: "Exclusively fictional data.",
                        });
                        await refresh();
                        setToast("Fictional dataset created.");
                      });
                    }}
                  >
                    <label>
                      Name
                      <input
                        required
                        minLength={2}
                        value={newDataset.name}
                        onChange={(e) =>
                          setNewDataset({ ...newDataset, name: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Description
                      <textarea
                        value={newDataset.description}
                        onChange={(e) =>
                          setNewDataset({
                            ...newDataset,
                            description: e.target.value,
                          })
                        }
                      />
                    </label>
                    <button disabled={busy || !project}>Create dataset</button>
                  </form>
                </section>
              </div>
              <section className="panel">
                <h2>Users and status</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name / email</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Control</th>
                      </tr>
                    </thead>
                    <tbody>
                      {admin.users.map((u: Row) => (
                        <tr key={u.id}>
                          <td>
                            {u.name}
                            <small>{u.email}</small>
                          </td>
                          <td>{labels[u.role]}</td>
                          <td>{u.active ? "Active" : "Disabled"}</td>
                          <td>
                            {u.id !== user.id && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void task(async () => {
                                    await api(`/admin/users/${u.id}`, {
                                      active: !u.active,
                                      role: u.role,
                                    });
                                    setAdmin(await api("/admin"));
                                  })
                                }
                              >
                                {u.active ? "Disable" : "Enable"}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
          <footer>
            BioAccess · Research prototype{" "}
            <span>
              Not certified for sensitive biological data. External validation
              is pending.
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
