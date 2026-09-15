import { createColors } from 'picocolors';
import type { StatuslineInput } from '../types/claude-events.js';
import { formatTokens, formatUsd } from '../format/currency.js';
import { progressBar } from '../format/tables.js';
import { writeOut } from '../format/output.js';
import { computeSessionUsage, type SessionUsage } from '../statusline/session-cost.js';
import { buildResolver } from '../pricing/pricing-loader.js';
import { projectsDir, statuslineCachePath } from '../config/paths.js';

/** Options de la commande `statusline`. */
export interface StatuslineOptions {
  /** Format d'affichage. */
  format?: 'oneline' | 'compact';
  /** Désactive la couleur (équivaut aussi à la variable d'environnement `NO_COLOR`). */
  noColor?: boolean;
}

/** Occupation du contexte calculée à partir du payload statusline. */
interface ContextUsage {
  percent: number | null;
  usedTokens: number | null;
  size: number | null;
}

/**
 * Détermine l'occupation du contexte : privilégie `used_percentage` (déjà calculé par Claude Code),
 * sinon retombe sur `current_usage` (tokens d'entrée uniquement, comme la formule officielle).
 */
export function computeContext(input: StatuslineInput): ContextUsage {
  const cw = input.context_window;
  if (!cw) {
    return { percent: null, usedTokens: null, size: null };
  }
  const size = cw.context_window_size ?? null;
  const usedTokens = cw.total_input_tokens ?? sumCurrentUsage(input);

  let percent: number | null = cw.used_percentage ?? null;
  if (percent == null && usedTokens != null && size != null && size > 0) {
    percent = (usedTokens / size) * 100;
  }
  return { percent, usedTokens, size };
}

/** Somme des tokens d'entrée (frais + cache) du dernier appel, ou `null` si indisponible. */
function sumCurrentUsage(input: StatuslineInput): number | null {
  const cu = input.context_window?.current_usage;
  if (!cu) {
    return null;
  }
  return (
    (cu.input_tokens ?? 0) +
    (cu.cache_creation_input_tokens ?? 0) +
    (cu.cache_read_input_tokens ?? 0)
  );
}

/** Raccourcit un identifiant de modèle pour l'affichage (`claude-opus-5` → `opus-5`). */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '');
}

/**
 * Résume les sous-agents de la session : leur nombre, puis leur répartition par modèle.
 * Chaîne vide s'il n'y a aucun agent — la statusline ne doit pas s'allonger pour rien.
 *
 * La statusline n'a pas la place d'afficher les TITRES des agents : c'est le rôle du tableau de
 * bord et de `ccmon agents`, qui montrent le modèle derrière le titre de chacun.
 */
export function formatAgents(usage: SessionUsage | null): string {
  if (!usage || usage.agentCount === 0) {
    return '';
  }
  const noun = usage.agentCount === 1 ? 'agent' : 'agents';
  const breakdown = usage.agentsByModel
    .map(({ model, count }) => `${count}×${shortModel(model)}`)
    .join(' ');
  return breakdown === '' ? `${usage.agentCount} ${noun}` : `${usage.agentCount} ${noun} ${breakdown}`;
}

/**
 * Résume le skill en cours et ce qu'il a coûté depuis son début, sous-agents inclus.
 * Chaîne vide hors skill — la statusline ne doit pas s'allonger pour rien.
 *
 * La garde porte sur la VALEUR FAUSSE et non sur `null` seul : un nom de skill n'est jamais
 * vide, et un champ absent doit produire une ligne sans segment plutôt qu'un « /undefined ».
 */
export function formatSkill(usage: SessionUsage | null): string {
  if (!usage || !usage.currentSkill) {
    return '';
  }
  return `/${usage.currentSkill} ${formatUsd(usage.currentSkillCost ?? 0)}`;
}

/**
 * Construit la ligne de statusline à afficher.
 * Tolère tout champ manquant ou `null` (affiché « — »).
 *
 * @param sessionUsage consommation complète calculée par ccmon (cache + sous-agents inclus).
 *        Son coût remplace le `cost.total_cost_usd` natif de Claude Code (qui sous-compte).
 */
export function formatStatusline(
  input: StatuslineInput,
  opts: StatuslineOptions = {},
  sessionUsage?: SessionUsage | null,
): string {
  const useColor = !opts.noColor && !process.env.NO_COLOR;
  const c = createColors(useColor);

  const model = input.model?.display_name ?? input.model?.id ?? '—';
  const cost = sessionUsage?.cost ?? input.cost?.total_cost_usd;
  const costText = cost == null ? '—' : formatUsd(cost);

  const ctx = computeContext(input);
  const pctText = ctx.percent == null ? '—' : `${Math.round(ctx.percent)}%`;
  const bar = progressBar(ctx.percent ?? 0);
  const coloredBar = ctx.percent == null ? bar : colorByUsage(c, ctx.percent)(bar);
  const tokensText = ctx.usedTokens == null ? '' : ` (${formatTokens(ctx.usedTokens)})`;

  if (opts.format === 'compact') {
    return `${c.green(costText)} ${coloredBar} ${pctText}`;
  }

  const segments = [c.bold(model), c.green(costText), `${coloredBar} ${pctText}${tokensText}`];
  const skill = formatSkill(sessionUsage ?? null);
  if (skill !== '') {
    segments.push(c.magenta(skill));
  }
  const agents = formatAgents(sessionUsage ?? null);
  if (agents !== '') {
    segments.push(c.cyan(agents));
  }
  return segments.join(' · ');
}

/** Choisit une couleur de barre selon le taux d'occupation. */
function colorByUsage(
  c: ReturnType<typeof createColors>,
  percent: number,
): (text: string) => string {
  if (percent >= 85) {
    return c.red;
  }
  if (percent >= 60) {
    return c.yellow;
  }
  return c.green;
}

/** Lit l'intégralité de l'entrée standard (vide si attachée à un TTY). */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', () => resolve(data));
  });
}

/**
 * Calcule la consommation complète de la session (cache + sous-agents inclus) ; renvoie `null`
 * en cas d'échec pour retomber sur le chiffre natif de Claude Code.
 */
function fullSessionUsage(input: StatuslineInput): SessionUsage | null {
  try {
    return computeSessionUsage({
      transcriptPath: input.transcript_path,
      sessionId: input.session_id,
      cwd: input.cwd ?? input.workspace?.current_dir,
      projectsDir: projectsDir(),
      resolver: buildResolver(),
      cachePath: statuslineCachePath(),
    });
  } catch {
    return null;
  }
}

/** Exécute la commande statusline : lit le JSON sur stdin et écrit une ligne sur stdout. */
export async function runStatusline(opts: StatuslineOptions): Promise<void> {
  const raw = await readStdin();
  let input: StatuslineInput = {};
  if (raw.trim().length > 0) {
    try {
      input = JSON.parse(raw) as StatuslineInput;
    } catch {
      // Entrée illisible : on affiche une ligne neutre plutôt que d'échouer.
      input = {};
    }
  }
  writeOut(formatStatusline(input, opts, fullSessionUsage(input)));
}
