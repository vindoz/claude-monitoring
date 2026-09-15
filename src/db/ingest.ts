import { statSync } from 'node:fs';
import type { Db } from './database.js';
import { AGENTS_BACKFILLED_KEY, SKILLS_BACKFILLED_KEY } from './schema.js';
import { readJsonlFromLine, walkJsonlFiles } from '../parser/jsonl-parser.js';
import { parseSessionPath, readAgentMeta } from '../parser/session-path.js';
import { isAiTitleEvent, isAssistantEvent, isUserEvent } from '../types/claude-events.js';
import {
  extractAssistantUsage,
  extractToolResults,
  extractToolUses,
  skillInvocationFrom,
} from '../report/usage-aggregation.js';

/** Bilan d'une ingestion. */
export interface IngestResult {
  filesScanned: number;
  filesIngested: number;
  filesUnchanged: number;
  linesParsed: number;
  linesCorrupted: number;
  messagesCounted: number;
  messagesDuplicate: number;
  messagesSkippedNoId: number;
  messagesSkippedNoModel: number;
  /** Nombre de transcripts d'agents dont le grain agent a été (re)calculé. */
  agentsIngested: number;
  /** Vrai si cette exécution a rattrapé le grain agent sur l'historique déjà ingéré. */
  agentsBackfilled: boolean;
  /** Nombre de messages imputés au grain skill (déduplication propre à ce grain). */
  skillMessagesIngested: number;
  /** Nombre d'appels d'outils nouvellement comptés. */
  toolCallsIngested: number;
  /** Nombre de résultats d'outils encaissés (poids de contexte injecté). */
  toolResultsIngested: number;
  /** Vrai si cette exécution a rattrapé les grains skill et outil sur l'historique. */
  skillsBackfilled: boolean;
  durationMs: number;
}

/** Options d'ingestion. */
export interface IngestOptions {
  /** Réindexe intégralement tous les fichiers (ignore le curseur incrémental). */
  force?: boolean;
  /** Rappel de progression (appelé pour chaque fichier traité), pour l'affichage. */
  onProgress?: (done: number, total: number) => void;
}

/** Lit un drapeau interne de la table `meta`, ou `null` s'il n'a jamais été posé. */
function readMeta(db: Db, key: string): string | null {
  const row = db.prepare<[string]>('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Pose (ou remplace) un drapeau interne de la table `meta`. */
function writeMeta(db: Db, key: string, value: string): void {
  db.prepare<[string, string]>(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Convertit un horodatage ISO en millisecondes, ou `null` si absent/invalide. */
function tsToMs(timestamp: string | undefined): number | null {
  if (!timestamp) {
    return null;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** Extrait le jour `YYYY-MM-DD` (UTC) d'un horodatage ISO, ou `'unknown'`. */
function tsToDay(timestamp: string | undefined): string {
  if (timestamp && timestamp.length >= 10) {
    return timestamp.slice(0, 10);
  }
  return 'unknown';
}

/** Accumulateur de métadonnées de session sur un fichier. */
interface SessionAccumulator {
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  firstTs: number | null;
  lastTs: number | null;
}

/** Accumulateur de bornes temporelles d'un agent sur son transcript. */
interface AgentAccumulator {
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Lance l'ingestion incrémentale récursive des transcripts vers la base.
 * Idempotente : la déduplication `(message_id, request_id)` garantit qu'une ré-ingestion
 * (totale ou partielle) ne double jamais les coûts.
 */
export function ingest(db: Db, projectsDir: string, options: IngestOptions = {}): IngestResult {
  const startedAt = Date.now();

  // Rattrapage : le curseur incrémental saute les fichiers inchangés AVANT toute lecture, si
  // bien qu'un grain ajouté après coup resterait vide sur tout l'historique déjà ingéré. Tant
  // que le drapeau est absent, on force une passe complète — non destructive, car les messages
  // déjà comptés sont rejetés par `seen_messages` et le grain agent est recalculé par fichier.
  const agentsBackfillNeeded = readMeta(db, AGENTS_BACKFILLED_KEY) === null;
  const skillsBackfillNeeded = readMeta(db, SKILLS_BACKFILLED_KEY) === null;
  const forceAll = options.force === true || agentsBackfillNeeded || skillsBackfillNeeded;

  const result: IngestResult = {
    filesScanned: 0,
    filesIngested: 0,
    filesUnchanged: 0,
    linesParsed: 0,
    linesCorrupted: 0,
    messagesCounted: 0,
    messagesDuplicate: 0,
    messagesSkippedNoId: 0,
    messagesSkippedNoModel: 0,
    agentsIngested: 0,
    agentsBackfilled: agentsBackfillNeeded,
    skillMessagesIngested: 0,
    toolCallsIngested: 0,
    toolResultsIngested: 0,
    skillsBackfilled: skillsBackfillNeeded,
    durationMs: 0,
  };

  const selFile = db.prepare<[string]>(
    'SELECT size, mtime_ms AS mtimeMs, lines_read AS linesRead FROM ingested_files WHERE path = ?',
  );
  const upsertFile = db.prepare(
    `INSERT INTO ingested_files (path, size, mtime_ms, lines_read, ingested_at)
     VALUES (@path, @size, @mtimeMs, @linesRead, @ingestedAt)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size, mtime_ms = excluded.mtime_ms,
       lines_read = excluded.lines_read, ingested_at = excluded.ingested_at`,
  );
  const insSeen = db.prepare<[string, string]>(
    'INSERT OR IGNORE INTO seen_messages (message_id, request_id) VALUES (?, ?)',
  );
  const upsertRollup = db.prepare(
    `INSERT INTO usage_rollup (
       session_id, project_slug, model, day, message_count,
       input_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
       output_tokens, web_search_requests, web_fetch_requests)
     VALUES (
       @sessionId, @projectSlug, @model, @day, 1,
       @input, @cw5, @cw1, @cacheRead, @output, @webSearch, @webFetch)
     ON CONFLICT(session_id, model, day) DO UPDATE SET
       message_count         = message_count + 1,
       input_tokens          = input_tokens + excluded.input_tokens,
       cache_write_5m_tokens = cache_write_5m_tokens + excluded.cache_write_5m_tokens,
       cache_write_1h_tokens = cache_write_1h_tokens + excluded.cache_write_1h_tokens,
       cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
       output_tokens         = output_tokens + excluded.output_tokens,
       web_search_requests   = web_search_requests + excluded.web_search_requests,
       web_fetch_requests    = web_fetch_requests + excluded.web_fetch_requests`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO sessions (session_id, project_slug, cwd, title, first_ts, last_ts, git_branch)
     VALUES (@sessionId, @projectSlug, @cwd, @title, @firstTs, @lastTs, @gitBranch)
     ON CONFLICT(session_id) DO UPDATE SET
       project_slug = excluded.project_slug,
       cwd        = COALESCE(excluded.cwd, cwd),
       git_branch = COALESCE(excluded.git_branch, git_branch),
       title      = COALESCE(excluded.title, title),
       first_ts   = MIN(COALESCE(first_ts, excluded.first_ts), COALESCE(excluded.first_ts, first_ts)),
       last_ts    = MAX(COALESCE(last_ts, excluded.last_ts), COALESCE(excluded.last_ts, last_ts))`,
  );

  // Le grain agent est RECALCULÉ intégralement à chaque traitement d'un transcript d'agent
  // (purge puis réinsertion, dédup par ensemble local au fichier). Il ne dépend donc pas de
  // `seen_messages`, qui est global et ne peut pas être purgé pour un seul agent.
  const delAgentRollup = db.prepare<[string]>('DELETE FROM agent_rollup WHERE agent_id = ?');
  const upsertAgentRollup = db.prepare(
    `INSERT INTO agent_rollup (
       agent_id, session_id, project_slug, model, day, message_count,
       input_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
       output_tokens, web_search_requests, web_fetch_requests)
     VALUES (
       @agentId, @sessionId, @projectSlug, @model, @day, 1,
       @input, @cw5, @cw1, @cacheRead, @output, @webSearch, @webFetch)
     ON CONFLICT(agent_id, model, day) DO UPDATE SET
       message_count         = message_count + 1,
       input_tokens          = input_tokens + excluded.input_tokens,
       cache_write_5m_tokens = cache_write_5m_tokens + excluded.cache_write_5m_tokens,
       cache_write_1h_tokens = cache_write_1h_tokens + excluded.cache_write_1h_tokens,
       cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
       output_tokens         = output_tokens + excluded.output_tokens,
       web_search_requests   = web_search_requests + excluded.web_search_requests,
       web_fetch_requests    = web_fetch_requests + excluded.web_fetch_requests`,
  );
  const upsertAgent = db.prepare(
    `INSERT INTO agents (
       agent_id, session_id, project_slug, agent_type, description,
       parent_agent_id, spawn_depth, first_ts, last_ts)
     VALUES (
       @agentId, @sessionId, @projectSlug, @agentType, @description,
       @parentAgentId, @spawnDepth, @firstTs, @lastTs)
     ON CONFLICT(agent_id) DO UPDATE SET
       session_id      = excluded.session_id,
       project_slug    = excluded.project_slug,
       agent_type      = COALESCE(excluded.agent_type, agent_type),
       description     = COALESCE(excluded.description, description),
       parent_agent_id = COALESCE(excluded.parent_agent_id, parent_agent_id),
       spawn_depth     = COALESCE(excluded.spawn_depth, spawn_depth),
       first_ts        = excluded.first_ts,
       last_ts         = excluded.last_ts`,
  );

  // Grain SKILL. Sa déduplication lui est PROPRE : `seen_messages` est déjà peuplé sur tout
  // l'historique, s'y adosser rendrait le rattrapage inerte (rien à insérer, donc rien à
  // compter). Elle est franchie EN AMONT de la barrière du grain session.
  const insSeenSkill = db.prepare<[string, string]>(
    'INSERT OR IGNORE INTO seen_skill_messages (message_id, request_id) VALUES (?, ?)',
  );
  const upsertSkillRollup = db.prepare(
    `INSERT INTO skill_rollup (
       session_id, project_slug, skill, model, day, message_count,
       input_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
       output_tokens, web_search_requests, web_fetch_requests)
     VALUES (
       @sessionId, @projectSlug, @skill, @model, @day, 1,
       @input, @cw5, @cw1, @cacheRead, @output, @webSearch, @webFetch)
     ON CONFLICT(session_id, skill, model, day) DO UPDATE SET
       message_count         = message_count + 1,
       input_tokens          = input_tokens + excluded.input_tokens,
       cache_write_5m_tokens = cache_write_5m_tokens + excluded.cache_write_5m_tokens,
       cache_write_1h_tokens = cache_write_1h_tokens + excluded.cache_write_1h_tokens,
       cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
       output_tokens         = output_tokens + excluded.output_tokens,
       web_search_requests   = web_search_requests + excluded.web_search_requests,
       web_fetch_requests    = web_fetch_requests + excluded.web_fetch_requests`,
  );
  // Filiation des skills : le premier parent rencontré dans la session fait foi (cf. README).
  const insSkillEdge = db.prepare(
    `INSERT OR IGNORE INTO skill_edges (session_id, project_slug, child_skill, parent_skill, first_ts)
     VALUES (@sessionId, @projectSlug, @child, @parent, @firstTs)`,
  );

  // Grain OUTIL. `seen_tool_calls` est un marqueur PERMANENT d'unicité, jamais supprimé : un
  // transcript d'agent est relu depuis la ligne 0 à chaque passage, et `--force` relit tout —
  // supprimer la ligne à la consommation du résultat ferait re-compter l'appel à chaque fois.
  const insSeenTool = db.prepare(
    `INSERT OR IGNORE INTO seen_tool_calls (
       tool_use_id, session_id, project_slug, tool, server, skill, day, resolved)
     VALUES (@toolUseId, @sessionId, @projectSlug, @tool, @server, @skill, @day, 0)`,
  );
  const upsertToolCall = db.prepare(
    `INSERT INTO tool_rollup (session_id, project_slug, tool, server, skill, day, call_count)
     VALUES (@sessionId, @projectSlug, @tool, @server, @skill, @day, 1)
     ON CONFLICT(session_id, tool, skill, day) DO UPDATE SET call_count = call_count + 1`,
  );
  // L'encaissement d'un résultat est gardé par la transition 0 → 1 de `resolved` : c'est elle,
  // et non la présence de la ligne, qui garantit qu'un résultat n'est ajouté qu'une fois.
  const resolveToolCall = db.prepare<[string]>(
    'UPDATE seen_tool_calls SET resolved = 1 WHERE tool_use_id = ? AND resolved = 0',
  );
  const selToolCall = db.prepare<[string]>(
    `SELECT session_id AS sessionId, tool, skill, day
     FROM seen_tool_calls WHERE tool_use_id = ?`,
  );
  const addToolResult = db.prepare(
    `UPDATE tool_rollup
        SET error_count   = error_count + @errors,
            result_chars  = result_chars + @chars,
            result_images = result_images + @images
      WHERE session_id = @sessionId AND tool = @tool AND skill = @skill AND day = @day`,
  );

  const files = walkJsonlFiles(projectsDir);
  result.filesScanned = files.length;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const info = parseSessionPath(file, projectsDir);
    if (!info) {
      continue;
    }

    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(file);
      size = st.size;
      mtimeMs = Math.floor(st.mtimeMs);
    } catch {
      continue; // fichier disparu entre le walk et le stat
    }

    const prev = forceAll
      ? undefined
      : (selFile.get(file) as { size: number; mtimeMs: number; linesRead: number } | undefined);

    let startLine = 0;
    if (prev) {
      if (prev.size === size && prev.mtimeMs === mtimeMs) {
        result.filesUnchanged += 1;
        options.onProgress?.(i + 1, files.length);
        continue; // inchangé
      }
      // Fichier agrandi → reprise en append ; sinon (rétréci / réécrit) → ré-ingestion totale.
      startLine = size > prev.size ? prev.linesRead : 0;
    }

    // Un transcript d'agent est toujours relu en entier (son rollup est recalculé) ; le
    // comptage principal, lui, reste incrémental grâce au filtrage sur `lineIndex` ci-dessous.
    const agentId = info.agentId;
    const read = readJsonlFromLine(file, agentId === null ? startLine : 0);
    result.linesParsed += read.parsedCount;
    result.linesCorrupted += read.corruptedCount;

    const acc: SessionAccumulator = {
      cwd: null,
      gitBranch: null,
      title: null,
      firstTs: null,
      lastTs: null,
    };
    const agentAcc: AgentAccumulator = { firstTs: null, lastTs: null };
    const seenInAgentFile = new Set<string>();

    const runFile = db.transaction(() => {
      if (agentId !== null) {
        delAgentRollup.run(agentId);
      }

      for (const { event, lineIndex } of read.events) {
        if (isAiTitleEvent(event)) {
          if (event.aiTitle) {
            acc.title = event.aiTitle;
          }
          continue;
        }

        // Résultats d'outils : portés par un event `user` POSTÉRIEUR à l'appel, parfois dans
        // une fenêtre d'ingestion ultérieure. `seen_tool_calls` les recolle à leur appel.
        if (isUserEvent(event)) {
          for (const res of extractToolResults(event)) {
            if (resolveToolCall.run(res.toolUseId).changes === 0) {
              continue; // appel inconnu, ou résultat déjà encaissé
            }
            const call = selToolCall.get(res.toolUseId) as
              | { sessionId: string; tool: string; skill: string; day: string }
              | undefined;
            if (!call) {
              continue;
            }
            addToolResult.run({
              sessionId: call.sessionId,
              tool: call.tool,
              skill: call.skill,
              day: call.day,
              errors: res.isError ? 1 : 0,
              chars: res.chars,
              images: res.images,
            });
            result.toolResultsIngested += 1;
          }
          continue;
        }

        if (!isAssistantEvent(event)) {
          continue;
        }

        const ms = tsToMs(event.timestamp);
        if (ms !== null) {
          acc.firstTs = acc.firstTs === null ? ms : Math.min(acc.firstTs, ms);
          acc.lastTs = acc.lastTs === null ? ms : Math.max(acc.lastTs, ms);
          agentAcc.firstTs = agentAcc.firstTs === null ? ms : Math.min(agentAcc.firstTs, ms);
          agentAcc.lastTs = agentAcc.lastTs === null ? ms : Math.max(agentAcc.lastTs, ms);
        }
        if (event.cwd) {
          acc.cwd = event.cwd;
        }
        if (event.gitBranch) {
          acc.gitBranch = event.gitBranch;
        }

        const day = tsToDay(event.timestamp);

        // Grain OUTIL et filiation des skills : relevés sur TOUTES les lignes, avant toute
        // déduplication. Un message logique s'étale à raison d'un bloc par ligne, et les
        // `tool_use` vivent précisément sur les lignes que la dédup `(id, requestId)` rejette.
        for (const use of extractToolUses(event)) {
          const firstSeen = insSeenTool.run({
            toolUseId: use.id,
            sessionId: info.sessionId,
            projectSlug: info.projectSlug,
            tool: use.tool,
            server: use.server,
            skill: use.skill,
            day,
          });
          if (firstSeen.changes === 1) {
            upsertToolCall.run({
              sessionId: info.sessionId,
              projectSlug: info.projectSlug,
              tool: use.tool,
              server: use.server,
              skill: use.skill,
              day,
            });
            result.toolCallsIngested += 1;
          }
        }

        const edge = skillInvocationFrom(event);
        if (edge) {
          insSkillEdge.run({
            sessionId: info.sessionId,
            projectSlug: info.projectSlug,
            child: edge.child,
            parent: edge.parent,
            firstTs: ms,
          });
        }

        // Règle de comptabilisation partagée avec le statusline (cf. usage-aggregation) :
        // la raison du rejet est portée par le helper, l'ingestion ne fait que la ventiler.
        const extracted = extractAssistantUsage(event);
        if (!extracted.ok) {
          if (extracted.reason === 'no-model') {
            result.messagesSkippedNoModel += 1;
          } else if (extracted.reason === 'no-id') {
            result.messagesSkippedNoId += 1;
          }
          continue; // 'synthetic' : gratuit, exclu silencieusement
        }

        const counts = extracted.counts;

        // Grain SKILL : sa propre déduplication, franchie AVANT la barrière du grain session.
        // Adossé à `seen_messages`, il n'aurait jamais rien écrit sur l'historique existant.
        if (insSeenSkill.run(extracted.messageId, extracted.requestId).changes === 1) {
          upsertSkillRollup.run({
            sessionId: info.sessionId,
            projectSlug: info.projectSlug,
            skill: extracted.skill,
            model: extracted.model,
            day,
            input: counts.input,
            cw5: counts.cacheWrite5m,
            cw1: counts.cacheWrite1h,
            cacheRead: counts.cacheRead,
            output: counts.output,
            webSearch: counts.webSearch,
            webFetch: counts.webFetch,
          });
          result.skillMessagesIngested += 1;
        }

        if (agentId !== null) {
          const key = `${extracted.messageId}|${extracted.requestId}`;
          if (!seenInAgentFile.has(key)) {
            seenInAgentFile.add(key);
            upsertAgentRollup.run({
              agentId,
              sessionId: info.sessionId,
              projectSlug: info.projectSlug,
              model: extracted.model,
              day,
              input: counts.input,
              cw5: counts.cacheWrite5m,
              cw1: counts.cacheWrite1h,
              cacheRead: counts.cacheRead,
              output: counts.output,
              webSearch: counts.webSearch,
              webFetch: counts.webFetch,
            });
          }
        }

        // Lignes déjà ingérées lors d'une passe précédente : relues pour le grain agent, elles
        // ne doivent pas repasser par le comptage principal.
        if (lineIndex < startLine) {
          continue;
        }
        const inserted = insSeen.run(extracted.messageId, extracted.requestId);
        if (inserted.changes === 0) {
          result.messagesDuplicate += 1;
          continue; // message déjà compté (ligne répétée ou session rejouée)
        }

        upsertRollup.run({
          sessionId: info.sessionId,
          projectSlug: info.projectSlug,
          model: extracted.model,
          day,
          input: counts.input,
          cw5: counts.cacheWrite5m,
          cw1: counts.cacheWrite1h,
          cacheRead: counts.cacheRead,
          output: counts.output,
          webSearch: counts.webSearch,
          webFetch: counts.webFetch,
        });
        result.messagesCounted += 1;
      }

      if (agentId !== null) {
        const meta = readAgentMeta(file);
        upsertAgent.run({
          agentId,
          sessionId: info.sessionId,
          projectSlug: info.projectSlug,
          agentType: meta?.agentType ?? null,
          description: meta?.description ?? null,
          parentAgentId: meta?.parentAgentId ?? null,
          spawnDepth: meta?.spawnDepth ?? null,
          firstTs: agentAcc.firstTs,
          lastTs: agentAcc.lastTs,
        });
        result.agentsIngested += 1;
      }

      upsertSession.run({
        sessionId: info.sessionId,
        projectSlug: info.projectSlug,
        cwd: acc.cwd,
        title: acc.title,
        firstTs: acc.firstTs,
        lastTs: acc.lastTs,
        gitBranch: acc.gitBranch,
      });
      upsertFile.run({
        path: file,
        size,
        mtimeMs,
        linesRead: read.totalLines,
        ingestedAt: Date.now(),
      });
    });
    runFile();
    result.filesIngested += 1;
    options.onProgress?.(i + 1, files.length);
  }

  const finishedAtIso = new Date(startedAt).toISOString();
  if (agentsBackfillNeeded) {
    writeMeta(db, AGENTS_BACKFILLED_KEY, finishedAtIso);
  }
  if (skillsBackfillNeeded) {
    writeMeta(db, SKILLS_BACKFILLED_KEY, finishedAtIso);
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
