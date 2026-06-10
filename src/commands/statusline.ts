import { createColors } from 'picocolors';
import type { StatuslineInput } from '../types/claude-events.js';
import { formatTokens, formatUsd } from '../format/currency.js';
import { progressBar } from '../format/tables.js';
import { writeOut } from '../format/output.js';

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

/**
 * Construit la ligne de statusline à afficher.
 * Tolère tout champ manquant ou `null` (affiché « — »).
 */
export function formatStatusline(input: StatuslineInput, opts: StatuslineOptions = {}): string {
  const useColor = !opts.noColor && !process.env.NO_COLOR;
  const c = createColors(useColor);

  const model = input.model?.display_name ?? input.model?.id ?? '—';
  const cost = input.cost?.total_cost_usd;
  const costText = cost == null ? '—' : formatUsd(cost);

  const ctx = computeContext(input);
  const pctText = ctx.percent == null ? '—' : `${Math.round(ctx.percent)}%`;
  const bar = progressBar(ctx.percent ?? 0);
  const coloredBar = ctx.percent == null ? bar : colorByUsage(c, ctx.percent)(bar);
  const tokensText = ctx.usedTokens == null ? '' : ` (${formatTokens(ctx.usedTokens)})`;

  if (opts.format === 'compact') {
    return `${c.green(costText)} ${coloredBar} ${pctText}`;
  }

  return [
    c.bold(model),
    c.green(costText),
    `${coloredBar} ${pctText}${tokensText}`,
  ].join(' · ');
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
  writeOut(formatStatusline(input, opts));
}
