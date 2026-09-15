import { closeSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { ClaudeEvent } from '../types/claude-events.js';
import { splitCompleteLines } from '../parser/jsonl-parser.js';
import { extractAssistantUsage } from '../report/usage-aggregation.js';
import { addUsage, zeroUsage, type UsageCounts } from '../pricing/cost-model.js';

/**
 * Cache d'agrégation PAR FICHIER, à lecture incrémentale, pour le hot path du statusline.
 *
 * Le statusline est réaffiché en continu et recalculait jusqu'ici le coût complet de la session
 * en reparsant tous ses transcripts — plus de 600 ms sur une grosse session, soit le double du
 * budget. Deux propriétés des transcripts sont exploitées :
 *
 * 1. un fichier inchangé (même taille, même date) donne le même agrégat : on le mémorise ;
 * 2. un fichier ne fait que grossir par ajout en fin : on ne relit que les octets ajoutés,
 *    ce qui rend le coût indépendant de la taille du transcript principal.
 *
 * La validité de l'agrégation fichier par fichier repose sur un fait vérifié : la déduplication
 * `(message.id, requestId)` ne retire jamais de message ENTRE deux fichiers d'une même session
 * (mesuré sur toutes les sessions multi-fichiers). Sommer les agrégats par fichier équivaut donc
 * à dédupliquer globalement.
 */

/** Entrée de cache : empreinte du fichier, agrégat par modèle et curseur de lecture. */
interface CachedFile {
  /** Taille du fichier au dernier passage. */
  size: number;
  mtimeMs: number;
  /** Octets déjà agrégés — toujours sur une frontière de ligne. */
  parsedBytes: number;
  /** Compteurs par modèle, déjà dédupliqués. */
  byModel: Record<string, UsageCounts>;
  /** Compteurs par couple (skill, modèle) — clé produite par `skillModelKey`. */
  bySkillModel: Record<string, UsageCounts>;
  /**
   * Skill actif au DERNIER message compté, `null` si ce message n'était sous aucun skill.
   * Écrit à chaque message et non seulement quand un skill est présent : sinon le skill
   * resterait affiché indéfiniment après sa fin, la moitié des messages n'en portant aucun.
   */
  lastSkill: string | null;
  /**
   * Dernières clés `(message.id, requestId)` comptées. Un message logique s'étale sur plusieurs
   * lignes CONSÉCUTIVES qui répètent son `usage` ; une lecture incrémentale peut couper ce
   * groupe en deux. Ces quelques clés suffisent à ne pas le compter deux fois.
   */
  recentKeys: string[];
  /** Dernière utilisation (ms), pour purger les entrées devenues mortes. */
  usedAt: number;
}

/** Contenu sérialisé du cache. */
interface CacheFile {
  version: number;
  files: Record<string, CachedFile>;
}

/** Version du format : un changement invalide le cache existant plutôt que de le mal relire. */
const CACHE_VERSION = 3;

/** Au-delà de cet âge, une entrée jamais réutilisée est purgée (transcript supprimé). */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Nombre de clés conservées pour recoller un message coupé par une frontière de lecture. */
const RECENT_KEYS_MAX = 8;

/** Lit le cache, ou renvoie un cache vide si absent, illisible ou d'une autre version. */
function readCache(path: string): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
    if (parsed.version === CACHE_VERSION && typeof parsed.files === 'object' && parsed.files !== null) {
      return parsed;
    }
  } catch {
    // Cache absent ou corrompu : on repart de zéro, jamais d'échec du statusline.
  }
  return { version: CACHE_VERSION, files: {} };
}

/**
 * Écrit le cache de façon atomique (fichier temporaire puis renommage) : plusieurs sessions
 * Claude Code rafraîchissent leur statusline en parallèle et partagent ce fichier.
 */
function writeCache(path: string, cache: CacheFile, now: number): void {
  for (const [file, entry] of Object.entries(cache.files)) {
    if (now - entry.usedAt > MAX_AGE_MS) {
      delete cache.files[file];
    }
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, path);
  } catch {
    // Cache non écrit (disque plein, droits) : sans incidence, on recalculera au prochain appel.
    try {
      unlinkSync(tmp);
    } catch {
      // Rien à nettoyer.
    }
  }
}

/** Lit une tranche d'octets d'un fichier. `from` tombe toujours sur une frontière de ligne. */
function readByteRange(path: string, from: number, to: number): string {
  const fd = openSync(path, 'r');
  try {
    const length = to - from;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, from + read);
      if (chunk === 0) {
        break;
      }
      read += chunk;
    }
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Sépare le skill du modèle dans une clé d'agrégat (le NUL ne peut apparaître dans ni l'un ni l'autre). */
const SKILL_MODEL_SEPARATOR = '\u0000';

/** Construit la clé d'agrégat d'un couple (skill, modèle). */
export function skillModelKey(skill: string, model: string): string {
  return `${skill}${SKILL_MODEL_SEPARATOR}${model}`;
}

/** Décompose une clé d'agrégat en son couple (skill, modèle). */
export function splitSkillModelKey(key: string): { skill: string; model: string } {
  const index = key.indexOf(SKILL_MODEL_SEPARATOR);
  if (index === -1) {
    return { skill: key, model: '' };
  }
  return { skill: key.slice(0, index), model: key.slice(index + 1) };
}

/** Résultat de l'agrégation d'une fenêtre de texte JSONL. */
interface WindowAggregate {
  byModel: Map<string, UsageCounts>;
  bySkillModel: Map<string, UsageCounts>;
  /** Skill du dernier message compté — n'a de sens que si `keys` n'est pas vide. */
  lastSkill: string | null;
  /** Clés comptées, dans l'ordre de lecture. */
  keys: string[];
  /** Octets consommés : jusqu'au dernier saut de ligne inclus. */
  consumedBytes: number;
}

/**
 * Agrège les events d'une fenêtre de texte JSONL, en ignorant les messages déjà comptés.
 * Les lignes illisibles sont ignorées, comme à l'ingestion.
 */
function aggregateWindow(text: string, alreadySeen: Iterable<string>): WindowAggregate {
  const byModel = new Map<string, UsageCounts>();
  const bySkillModel = new Map<string, UsageCounts>();
  const seen = new Set(alreadySeen);
  const keys: string[] = [];
  let lastSkill: string | null = null;

  for (const line of splitCompleteLines(text)) {
    if (line.trim().length === 0) {
      continue;
    }
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      continue;
    }
    const extracted = extractAssistantUsage(event);
    if (!extracted.ok) {
      continue;
    }
    const key = `${extracted.messageId}|${extracted.requestId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
    byModel.set(extracted.model, addUsage(byModel.get(extracted.model) ?? zeroUsage(), extracted.counts));
    const skillKey = skillModelKey(extracted.skill, extracted.model);
    bySkillModel.set(skillKey, addUsage(bySkillModel.get(skillKey) ?? zeroUsage(), extracted.counts));
    lastSkill = extracted.rawSkill;
  }

  const lastNewline = text.lastIndexOf('\n');
  return {
    byModel,
    bySkillModel,
    lastSkill,
    keys,
    consumedBytes: lastNewline === -1 ? 0 : Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'),
  };
}

/** Agrégat d'un fichier, avec son chemin d'origine. */
export interface FileUsage {
  path: string;
  byModel: Map<string, UsageCounts>;
  /** Agrégat par couple (skill, modèle) — le coût dépend du modèle, l'imputation du skill. */
  bySkillModel: Map<string, UsageCounts>;
  /** Skill actif au dernier message compté de ce fichier, `null` sinon. */
  lastSkill: string | null;
}

/** Ajoute les compteurs d'une fenêtre à l'agrégat cumulé d'un fichier. */
function accumulate(target: Record<string, UsageCounts>, window: Map<string, UsageCounts>): void {
  for (const [key, counts] of window) {
    target[key] = addUsage(target[key] ?? zeroUsage(), counts);
  }
}

/**
 * Agrège l'usage d'une liste de transcripts, fichier par fichier, en s'appuyant sur le cache.
 * Les fichiers devenus illisibles sont ignorés, comme à l'ingestion.
 *
 * @param cachePath chemin du cache ; `null` désactive le cache (recalcul systématique).
 */
export function aggregateFilesCached(files: string[], cachePath: string | null): FileUsage[] {
  const cache = cachePath === null ? { version: CACHE_VERSION, files: {} } : readCache(cachePath);
  const now = Date.now();
  let changed = false;
  const results: FileUsage[] = [];

  for (const file of files) {
    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(file);
      size = stat.size;
      mtimeMs = Math.floor(stat.mtimeMs);
    } catch {
      continue; // fichier disparu entre le listage et la lecture
    }

    const cached = cache.files[file];

    // Fichier inchangé : l'agrégat mémorisé est valable tel quel.
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      cached.usedAt = now;
      results.push({
        path: file,
        byModel: new Map(Object.entries(cached.byModel)),
        bySkillModel: new Map(Object.entries(cached.bySkillModel ?? {})),
        lastSkill: cached.lastSkill ?? null,
      });
      continue;
    }

    try {
      // Fichier agrandi : on ne lit que les octets ajoutés depuis le dernier passage.
      if (cached && size >= cached.size && cached.parsedBytes <= size) {
        const window = aggregateWindow(
          readByteRange(file, cached.parsedBytes, size),
          cached.recentKeys,
        );
        accumulate(cached.byModel, window.byModel);
        cached.bySkillModel = cached.bySkillModel ?? {};
        accumulate(cached.bySkillModel, window.bySkillModel);
        // Une fenêtre sans message compté n'apprend rien sur le skill courant : on garde
        // la valeur précédente plutôt que de la remettre à zéro à chaque rafraîchissement.
        if (window.keys.length > 0) {
          cached.lastSkill = window.lastSkill;
        }
        cached.parsedBytes += window.consumedBytes;
        cached.recentKeys = [...cached.recentKeys, ...window.keys].slice(-RECENT_KEYS_MAX);
        cached.size = size;
        cached.mtimeMs = mtimeMs;
        cached.usedAt = now;
        changed = true;
        results.push({
          path: file,
          byModel: new Map(Object.entries(cached.byModel)),
          bySkillModel: new Map(Object.entries(cached.bySkillModel)),
          lastSkill: cached.lastSkill ?? null,
        });
        continue;
      }

      // Premier passage, ou fichier réécrit / tronqué : relecture complète.
      const window = aggregateWindow(readFileSync(file, 'utf8'), []);
      cache.files[file] = {
        size,
        mtimeMs,
        parsedBytes: window.consumedBytes,
        byModel: Object.fromEntries(window.byModel),
        bySkillModel: Object.fromEntries(window.bySkillModel),
        lastSkill: window.keys.length > 0 ? window.lastSkill : null,
        recentKeys: window.keys.slice(-RECENT_KEYS_MAX),
        usedAt: now,
      };
      changed = true;
      results.push({
        path: file,
        byModel: window.byModel,
        bySkillModel: window.bySkillModel,
        lastSkill: window.keys.length > 0 ? window.lastSkill : null,
      });
    } catch {
      continue; // fichier illisible : ignoré, comme à l'ingestion
    }
  }

  if (changed && cachePath !== null) {
    writeCache(cachePath, cache, now);
  }
  return results;
}

/** Somme les agrégats de plusieurs fichiers en un seul agrégat par modèle. */
export function mergeByModel(usages: FileUsage[]): Map<string, UsageCounts> {
  const total = new Map<string, UsageCounts>();
  for (const usage of usages) {
    for (const [model, counts] of usage.byModel) {
      total.set(model, addUsage(total.get(model) ?? zeroUsage(), counts));
    }
  }
  return total;
}
