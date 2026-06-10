/**
 * Point d'entrée unique des écritures de l'outil.
 * Centraliser ici évite tout `console.log` épars : la sortie de données va sur stdout,
 * les messages de progression et avertissements vont sur stderr (pour ne pas polluer `--json`).
 */

/** Écrit une ligne de résultat sur la sortie standard. */
export function writeOut(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/** Écrit un message d'information / d'avertissement sur la sortie d'erreur. */
export function writeErr(text = ''): void {
  process.stderr.write(`${text}\n`);
}

/** Écrit une valeur sérialisée en JSON indenté sur stdout. */
export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
