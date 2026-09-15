/**
 * Types décrivant les données lues par l'outil :
 * - les events des transcripts de session Claude Code (`~/.claude/projects/**​/*.jsonl`) ;
 * - le payload JSON fourni par Claude Code sur l'entrée standard du statusline.
 *
 * Ces types ne couvrent que les champs réellement exploités : les transcripts contiennent
 * bien d'autres clés qui ne nous intéressent pas pour le calcul de coût.
 */

/** Détail de la consommation de tokens d'un message assistant. */
export interface ClaudeUsage {
  /** Tokens d'entrée « frais » (non issus du cache). */
  input_tokens?: number;
  /** Tokens écrits dans le cache (cache creation, toutes durées confondues). */
  cache_creation_input_tokens?: number;
  /** Tokens lus depuis le cache (cache read). */
  cache_read_input_tokens?: number;
  /** Tokens de sortie générés. */
  output_tokens?: number;
  /** Répartition des tokens d'écriture de cache par durée d'éphémérité. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /** Compteurs d'appels aux outils serveur (recherche / fetch web), facturés à l'unité. */
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
}

/**
 * Élément d'un contenu de résultat d'outil livré sous forme de liste
 * (`text`, `image`, `tool_reference`). Seul `text` porte du texte exploitable ;
 * les images sont du base64 dont la longueur n'a aucun rapport avec son poids en tokens.
 */
export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Bloc `tool_use` d'un message assistant : un appel d'outil. */
export interface ToolUseBlock {
  type: 'tool_use';
  /** Identifiant de l'appel (`toolu_...`), unique sur l'ensemble des transcripts. */
  id?: string;
  /** Nom de l'outil (`Bash`, `mcp__jira__jira_get_issue`, `Skill`…). */
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Bloc `tool_result` : la réponse d'un outil, portée par un event `user` ULTÉRIEUR.
 * Son `content` prend deux formes : une chaîne (cas majoritaire) ou une liste de blocs.
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content?: string | ContentPart[];
  is_error?: boolean;
}

/** Bloc de contenu dont on n'exploite que le type (`thinking`, `text`…). */
export interface OtherBlock {
  type: string;
  [key: string]: unknown;
}

/** Union des blocs de contenu rencontrés dans un message. */
export type ContentBlock = ToolUseBlock | ToolResultBlock | OtherBlock;

/** Contenu du champ `message` d'un event assistant. */
export interface AssistantMessage {
  /** Identifiant du message (ex. `msg_...`), utilisé pour la déduplication. */
  id?: string;
  /** Modèle ayant produit la réponse (ex. `claude-opus-4-8`, `<synthetic>`). */
  model?: string;
  usage?: ClaudeUsage;
  /**
   * Blocs de contenu de CETTE ligne. Un message logique est réparti sur plusieurs lignes,
   * une par bloc : les `tool_use` vivent donc sur des lignes que la déduplication par
   * `(id, requestId)` rejette, d'où leur relevé en amont de celle-ci.
   */
  content?: ContentBlock[];
}

/**
 * Event « assistant » d'un transcript : la seule source de consommation de tokens.
 * Une même réponse logique est souvent répartie sur plusieurs lignes (un bloc de contenu
 * par ligne), chacune répétant le `usage` complet → d'où la déduplication par (id, requestId).
 */
export interface AssistantEvent {
  type: 'assistant';
  message?: AssistantMessage;
  /** Identifiant de requête API (ex. `req_...`), utilisé pour la déduplication. */
  requestId?: string;
  /** Vrai pour les transcripts d'agents (sous-tâches). */
  isSidechain?: boolean;
  /**
   * Skill actif au moment de la requête API — écrit nativement par Claude Code, y compris
   * dans les transcripts de sous-agents. Absent quand aucun skill n'est actif.
   *
   * Sur une chaîne `/epct-sexy` → `Skill(epct)`, ce champ porte le skill le PLUS INTERNE
   * (`epct`) ; la ligne qui émet le `tool_use` `Skill` porte encore l'appelant, ce qui permet
   * de reconstruire la filiation (cf. `skill_edges`).
   */
  attributionSkill?: string;
  /** Horodatage ISO 8601 de l'event. */
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
}

/**
 * Contenu du fichier `agent-<id>.meta.json` écrit par Claude Code à côté du transcript d'un
 * sous-agent. C'est la seule source du **titre** et du **type** de l'agent : le transcript
 * lui-même ne les porte pas.
 *
 * Le champ `model` y est parfois présent mais vaut un ALIAS (`"opus"`), pas un identifiant
 * tarifable : le modèle réellement facturé se lit dans `message.model` du transcript.
 */
export interface AgentMeta {
  /** Type d'agent (`plan-code`, `explore-code`, `general-purpose`, `Explore`…). */
  agentType?: string;
  /** Description donnée au lancement — c'est le titre affiché par Claude Code. */
  description?: string;
  /** Agent parent, présent uniquement pour les agents lancés par un autre agent. */
  parentAgentId?: string;
  /** Profondeur de lancement (1 = lancé par la boucle principale). */
  spawnDepth?: number;
  /** Identifiant de l'appel d'outil `Task` qui a lancé l'agent. */
  toolUseId?: string;
}

/**
 * Event « user » : porte notamment les `tool_result` des appels d'outils émis par
 * l'assistant. Aucun token ne lui est imputé — c'est le message assistant SUIVANT qui paie
 * le contenu injecté ici.
 */
export interface UserEvent {
  type: 'user';
  message?: {
    content?: string | ContentBlock[];
  };
  timestamp?: string;
  sessionId?: string;
}

/** Event « ai-title » : titre humain attribué à la session. */
export interface AiTitleEvent {
  type: 'ai-title';
  aiTitle?: string;
  sessionId?: string;
}

/** Forme minimale partagée par tous les events (pour discriminer sur `type`). */
export interface GenericEvent {
  type?: string;
  [key: string]: unknown;
}

/** Union des events que l'on sait traiter. */
export type ClaudeEvent = AssistantEvent | UserEvent | AiTitleEvent | GenericEvent;

/** Garde de type : event assistant. */
export function isAssistantEvent(event: ClaudeEvent): event is AssistantEvent {
  return event.type === 'assistant';
}

/** Garde de type : event user. */
export function isUserEvent(event: ClaudeEvent): event is UserEvent {
  return event.type === 'user';
}

/** Garde de type : event ai-title. */
export function isAiTitleEvent(event: ClaudeEvent): event is AiTitleEvent {
  return event.type === 'ai-title';
}

/**
 * Payload JSON envoyé par Claude Code sur stdin au script de statusline.
 * Plusieurs champs peuvent être `null` en début de session ou juste après `/compact`.
 */
export interface StatuslineInput {
  model?: {
    id?: string;
    display_name?: string;
  };
  context_window?: {
    total_input_tokens?: number | null;
    total_output_tokens?: number | null;
    context_window_size?: number | null;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
  cost?: {
    total_cost_usd?: number | null;
    total_duration_ms?: number | null;
    total_api_duration_ms?: number | null;
    total_lines_added?: number | null;
    total_lines_removed?: number | null;
  };
  workspace?: {
    current_dir?: string;
    project_dir?: string;
  };
  cwd?: string;
  session_id?: string;
  /** Chemin absolu du transcript de la session courante. */
  transcript_path?: string;
  gitBranch?: string;
}
