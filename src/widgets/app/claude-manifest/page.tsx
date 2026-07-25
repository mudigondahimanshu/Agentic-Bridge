'use client';

/**
 * Manifest panel — the CLAUDE.md artifact, plus the manual ingestion dropzone
 * for context the automated swarm could not reach.
 */

import { useState } from 'react';
import { Badge, Button, Card, Empty, Note, Pre, Shell, Stats, useBridgeTool } from '../../lib/ui';

interface Payload {
  written?: boolean;
  path?: string;
  bytes?: number;
  lines?: number;
  factsUsed?: number;
  skillsDocumented?: number;
  resolvedConflicts?: number;
  unresolvedConflicts?: number;
  content?: string;
  // ingest_manual_document shares this widget
  ingested?: boolean;
  document?: { id: string; name: string; chars: number };
  chunks?: number;
  totalDocuments?: number;
  nextStep?: string;
}

export default function ClaudeManifest() {
  const { data, busy, error, run, clearError } = useBridgeTool<Payload>();
  const [docName, setDocName] = useState('');
  const [docText, setDocText] = useState('');
  const [showIngest, setShowIngest] = useState(false);

  const ingest = async () => {
    const ok = await run('ingest_manual_document', { name: docName.trim(), text: docText });
    if (ok) {
      setDocName('');
      setDocText('');
    }
  };

  const readDroppedFile = async (file: File) => {
    const text = await file.text();
    setDocName(file.name);
    setDocText(text);
    setShowIngest(true);
  };

  return (
    <Shell
      icon="◈"
      title="CLAUDE.md Manifest"
      subtitle={data?.path ? `${data.path} · ${data.bytes ?? 0} bytes` : 'the deterministic context artifact'}
      error={error}
      onDismissError={clearError}
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => setShowIngest((v) => !v)}>
            {showIngest ? 'Close' : 'Inject context'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy === 'synthesize_claude_md'}
            onClick={() => run('synthesize_claude_md')}
          >
            Regenerate
          </Button>
        </>
      }
    >
      {data?.written ? (
        <Stats
          items={[
            { label: 'Lines', value: data.lines ?? 0, tone: 'accent' },
            { label: 'Facts used', value: data.factsUsed ?? 0 },
            { label: 'Skills', value: data.skillsDocumented ?? 0 },
            {
              label: 'Human rulings',
              value: data.resolvedConflicts ?? 0,
              tone: data.resolvedConflicts ? 'ok' : 'neutral',
            },
          ]}
        />
      ) : null}

      {data?.unresolvedConflicts ? (
        <Note tone="warn">
          {data.unresolvedConflicts} conflict(s) are still unresolved and were written in as an explicit
          warning block rather than silently guessed at.
        </Note>
      ) : null}

      {showIngest ? (
        <Card title="Inject context the swarm could not reach">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) void readDroppedFile(file);
            }}
            style={{
              border: '1px dashed var(--bx-line-strong)',
              borderRadius: 8,
              padding: 14,
              textAlign: 'center',
              fontSize: 11.5,
              color: 'var(--bx-fg-mute)',
              marginBottom: 10,
            }}
          >
            Drop a text or markdown file here, or paste below.
          </div>

          <div className="bx-field">
            <label className="bx-label" htmlFor="doc-name">
              Title
            </label>
            <input
              id="doc-name"
              className="bx-input"
              placeholder="e.g. ADR-021 — event bus rejected"
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
            />
          </div>
          <div className="bx-field">
            <label className="bx-label" htmlFor="doc-text">
              Content
            </label>
            <textarea
              id="doc-text"
              className="bx-textarea"
              placeholder="Paste the decision record, wiki page or Slack thread…"
              value={docText}
              onChange={(e) => setDocText(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            disabled={!docName.trim() || !docText.trim()}
            loading={busy === 'ingest_manual_document'}
            onClick={ingest}
          >
            Ingest &amp; embed
          </Button>

          {data?.ingested ? (
            <Note tone="ok">
              Ingested <strong>{data.document?.name}</strong> — {data.chunks} chunk(s), now searchable via{' '}
              <code>query_knowledge</code>. {data.nextStep}
            </Note>
          ) : null}
        </Card>
      ) : null}

      {data?.content ? (
        <Card
          title="Generated manifest"
          aside={<Badge tone="ok">deterministic · zero LLM calls</Badge>}
        >
          <Pre>{data.content}</Pre>
        </Card>
      ) : (
        <Empty
          icon="◈"
          title="Manifest not generated yet"
          hint={
            <>
              Run the swarm, resolve any conflicts, then call <code>synthesize_claude_md</code>.
            </>
          }
        />
      )}
    </Shell>
  );
}
