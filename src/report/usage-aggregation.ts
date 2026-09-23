import {
  isAssistantEvent,
  isUserEvent,
  type ClaudeEvent,
  type ContentBlock,
  type ContentPart,
  type ToolResultBlock,
  type ToolUseBlock,
} from '../types/claude-events.js';
import { billingModelId, isSyntheticModel } from '../pricing/model-normalizer.js';
import { addUsage, usageFromClaude, zeroUsage, type UsageCounts } from '../pricing/cost-model.js';

/**
 * Règle métier PARTAGÉE de comptabilisation d'un message assistant.
 * Centralise ici (réutilisée par l'ingestion DB et par le calcul de coût du statusline)
 * la décision « ce message est-il facturable ? » et l'extraction de ses compteurs, afin que
 * les deux chemins ne divergent jamais. La RAISON du rejet est portée par le helper (et non
 * redéduite par l'appelant) pour rester exacte si une cause de rejet est ajoutée.
 */
export type UsageExtraction =
  | {
      ok: true;
      model: string;
      messageId: string;
      requestId: string;
      counts: UsageCounts;
      /** Skill actif, ou `NO_SKILL` : une CLÉ plutôt que `null`, pour que le grain skill totalise
       *  exactement le grain session au lieu de perdre silencieusement les messages hors skill. */
      skill: string;
      /** Valeur brute d'`attributionSkill`, `null` hors skill (affichage du skill courant). */
      rawSkill: string | null;
    }
  | { ok: false; reason: 'not-assistant' | 'no-model' | 'synthetic' | 'no-id' };

/** Clé d'imputation des messages produits hors de tout skill. */
export const NO_SKILL = '(hors skill)';

/** Nom de l'outil qui invoque un skill — porte la filiation entre skills. */
const SKILL_TOOL_NAME = 'Skill';

/** Préfixe des outils exposés par un serveur MCP : `mcp__<serveur>__<outil>`. */
const MCP_TOOL_PATTERN = /^mcp__(.+?)__/;

/** Serveur d'appartenance d'un outil : `mcp:<serveur>`, ou `builtin` pour les outils natifs. */
export function serverOfTool(toolName: string): string {
  const matched = MCP_TOOL_PATTERN.exec(toolName);
  return matched ? `mcp:${matched[1]}` : 'builtin';
}

/** Extrait l'usage facturable d'un event, ou la raison pour laquelle il n'est pas comptable. */
export function extractAssistantUsage(event: ClaudeEvent): UsageExtraction {
  if (!isAssistantEvent(event)) {
    return { ok: false, reason: 'not-assistant' };
  }
  const model = event.message?.model;
  if (!model) {
    return { ok: false, reason: 'no-model' };
  }
  if (isSyntheticModel(model)) {
    return { ok: false, reason: 'synthetic' };
  }
  const messageId = event.message?.id;
  if (!messageId) {
    return { ok: false, reason: 'no-id' };
  }
  return {
    ok: true,
    // Le fast mode garde l'identifiant du modèle : c'est la clé qui porte le tarif doublé.
    model: billingModelId(model, event.message?.usage?.speed),
    messageId,
    requestId: event.requestId ?? '',
    counts: usageFromClaude(event.message?.usage),
    skill: event.attributionSkill ?? NO_SKILL,
    rawSkill: event.attributionSkill ?? null,
  };
}

/** Blocs de contenu d'un event, quelle que soit la forme du champ `message.content`. */
function contentBlocksOf(content: string | ContentBlock[] | undefined): ContentBlock[] {
  return Array.isArray(content) ? content : [];
}

/** Un appel d'outil relevé sur une ligne de transcript. */
export interface ToolUseRecord {
  /** Identifiant `toolu_...` — unique sur l'ensemble des transcripts, d'où son rôle de clé. */
  id: string;
  /** Nom complet de l'outil. */
  tool: string;
  /** Serveur d'appartenance (`mcp:jira`, `builtin`). */
  server: string;
  /** Skill actif au moment de l'appel, ou `NO_SKILL`. */
  skill: string;
}

/**
 * Relève les appels d'outils d'une ligne assistant.
 *
 * À appeler sur TOUTES les lignes, y compris celles que la déduplication `(id, requestId)`
 * rejette : un message logique est réparti à raison d'un bloc par ligne, et les `tool_use`
 * vivent précisément sur les lignes rejetées.
 */
export function extractToolUses(event: ClaudeEvent): ToolUseRecord[] {
  if (!isAssistantEvent(event)) {
    return [];
  }
  const skill = event.attributionSkill ?? NO_SKILL;
  const out: ToolUseRecord[] = [];
  for (const block of contentBlocksOf(event.message?.content)) {
    if (block.type !== 'tool_use') {
      continue;
    }
    const { id, name } = block as ToolUseBlock;
    if (!id || !name) {
      continue; // sans identifiant ni nom, l'appel n'est ni imputable ni dédupliquable
    }
    out.push({ id, tool: name, server: serverOfTool(name), skill });
  }
  return out;
}

/** Filiation entre deux skills : l'appelant et le skill qu'il invoque. */
export interface SkillEdge {
  parent: string;
  child: string;
}

/**
 * Relève l'arête `appelant → appelé` portée par un `tool_use` `Skill`.
 *
 * Deux gardes, sans lesquelles le « pipeline » serait faux :
 * - l'appelant doit avoir un `attributionSkill` RÉEL — une invocation depuis la boucle
 *   principale n'a pas de parent, l'enfant est alors lui-même la racine ;
 * - une arête réflexive (un skill qui se réinvoque) ne porte aucune information et évincerait
 *   la vraie arête, la clé primaire ne gardant qu'un parent par enfant et par session.
 */
export function skillInvocationFrom(event: ClaudeEvent): SkillEdge | null {
  if (!isAssistantEvent(event)) {
    return null;
  }
  const parent = event.attributionSkill;
  if (!parent) {
    return null;
  }
  for (const block of contentBlocksOf(event.message?.content)) {
    if (block.type !== 'tool_use' || (block as ToolUseBlock).name !== SKILL_TOOL_NAME) {
      continue;
    }
    const raw = (block as ToolUseBlock).input?.skill;
    const child = typeof raw === 'string' ? raw.trim() : '';
    if (child !== '' && child !== parent) {
      return { parent, child };
    }
  }
  return null;
}

/** Poids du résultat d'un appel d'outil : ce qu'il injecte dans le contexte. */
export interface ToolResultRecord {
  toolUseId: string;
  /** Caractères de texte injectés — les images en sont EXCLUES (cf. `images`). */
  chars: number;
  /** Nombre de blocs image : leur base64 n'a aucun rapport avec leur poids en tokens. */
  images: number;
  isError: boolean;
}

/** Poids en caractères d'un bloc d'un contenu de résultat livré sous forme de liste. */
function partChars(part: ContentPart): number {
  if (part.type === 'image') {
    return 0;
  }
  if (part.type === 'text') {
    return (part.text ?? '').length;
  }
  // `tool_reference` et formes inconnues : leur sérialisation est le meilleur substitut.
  return JSON.stringify(part).length;
}

/**
 * Relève les résultats d'outils d'un event `user`, avec le poids de contexte qu'ils injectent.
 * Le résultat arrive TOUJOURS sur un event ultérieur à l'appel, parfois dans une fenêtre
 * d'ingestion suivante : c'est `seen_tool_calls` qui les recolle.
 */
export function extractToolResults(event: ClaudeEvent): ToolResultRecord[] {
  if (!isUserEvent(event)) {
    return [];
  }
  const out: ToolResultRecord[] = [];
  for (const block of contentBlocksOf(event.message?.content)) {
    if (block.type !== 'tool_result') {
      continue;
    }
    const result = block as ToolResultBlock;
    if (!result.tool_use_id) {
      continue;
    }
    const content = result.content;
    let chars = 0;
    let images = 0;
    if (typeof content === 'string') {
      chars = content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        chars += partChars(part);
        if (part.type === 'image') {
          images += 1;
        }
      }
    }
    out.push({ toolUseId: result.tool_use_id, chars, images, isError: result.is_error === true });
  }
  return out;
}

/** Résultat d'agrégation en mémoire. */
export interface AggregatedUsage {
  /** Compteurs agrégés par modèle (le coût se calcule par modèle car les tarifs diffèrent). */
  byModel: Map<string, UsageCounts>;
  messagesCounted: number;
  duplicates: number;
}

/**
 * Agrège l'usage d'une liste d'events par modèle, en déduisant les doublons
 * `(message.id, requestId)` (un message logique est réparti sur plusieurs lignes répétant
 * le `usage`, et l'historique est rejoué — sans dédup le coût serait fortement sur-compté).
 */
export function aggregateUsageByModel(events: Iterable<ClaudeEvent>): AggregatedUsage {
  const byModel = new Map<string, UsageCounts>();
  const seen = new Set<string>();
  let messagesCounted = 0;
  let duplicates = 0;

  for (const event of events) {
    const extracted = extractAssistantUsage(event);
    if (!extracted.ok) {
      continue;
    }
    const key = `${extracted.messageId}|${extracted.requestId}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    byModel.set(extracted.model, addUsage(byModel.get(extracted.model) ?? zeroUsage(), extracted.counts));
    messagesCounted += 1;
  }

  return { byModel, messagesCounted, duplicates };
}
