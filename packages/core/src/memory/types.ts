/**
 * Types for Memory storage. Aligned with material-manager types for
 * material/frame storage, plus screenshot persistence.
 */

export interface Screenshot {
    screenshotId: string;
    timestamp: number;
    width: number;
    height: number;
    data: Buffer;
    mimeType: string;
    boundsX: number | null;
    boundsY: number | null;
    boundsW: number | null;
    boundsH: number | null;
    screenshotType: string | null;
}

export interface Material {
    materialId: string;
    title: string;
    windowId: number;
    application: string | null;
    bundleId: string | null;
    documentPath: string | null;
    lastFrameHash: string | null;
    firstSeen: number;
    lastSeen: number;
    materialType: string | null;
    materialTypeConfidence: number | null;
    totalTimeMs: number;
    /** Recency-decayed importance weight [0, 1]. Populated by computeAllMaterialWeights(). */
    weight: number | null;
    /** Application-specific metadata (e.g. URL for browsers, file path for IDEs). */
    appMetadata: Record<string, string | null> | null;
}

export interface MaterialFrame {
    frameId: string;
    materialId: string;
    windowId: number;
    timestamp: number;
    width: number;
    height: number;
    data: Buffer;
    title: string | null;
    application: string | null;
    bundleId: string | null;
    captureReason: string;
}

export interface Task {
    taskId: string;
    label: string;
    description: string | null;
    application: string | null;
    confidence: number | null;
    status: string;
    approach: string | null;
    parentTaskId: string | null;
    /** 'leaf' for fine-grained observations, 'goal' for LLM-inferred user goals */
    level: string;
    firstSeen: number;
    lastSeen: number;
    createdAt: number;
    updatedAt: number;
}

export interface TaskEvent {
    id: number;
    eventId: string | null;
    taskId: string;
    parentTaskId: string | null;
    status: string;
    label: string | null;
    description: string | null;
    application: string | null;
    confidence: number | null;
    approach: string | null;
    level: string | null;
    timestamp: number;
    requestTs: number | null;
    responseTs: number | null;
    createdAt: number;
}

// ── Personal network ──────────────────────────────────────────────────────────

/**
 * Stable identity anchor for a person in the user's personal network.
 * Role, company, email, and handle are NOT stored here — they live on each
 * PersonEncounter so that changes over time are preserved naturally.
 */
export interface Person {
    personId: string;
    /** Full display name */
    name: string;
    /** Freeform notes */
    notes: string | null;
    /** Most recently inferred relationship to the user (e.g. "student", "colleague") */
    relationship: string | null;
    /** Aggregated importance weight — max of all encounter weights. Higher = user paid more attention. */
    weight: number | null;
    /** Timestamp (ms) of the first detected encounter */
    firstSeen: number;
    /** Timestamp (ms) of the most recent detected encounter */
    lastSeen: number;
    /** Total number of encounters recorded */
    encounterCount: number;
}

/**
 * A single sighting of a person in the user's personal network.
 * Captures what was visible on screen at that moment — role, company, email,
 * and handle are recorded per-encounter so multiple values accumulate naturally.
 */
export interface PersonEncounter {
    encounterId: string;
    personId: string;
    /** Human-readable description of how/why they appeared on screen */
    context: string;
    /** App or service where the person was seen (e.g. "Gmail", "Slack", "LinkedIn") */
    platform: string | null;
    /** Focused application name at the time of detection */
    application: string | null;
    /** Role or title visible in this encounter */
    role: string | null;
    /** Company or organization visible in this encounter */
    company: string | null;
    /** Email address visible in this encounter */
    email: string | null;
    /** Social or platform handle visible in this encounter */
    handle: string | null;
    /** Relationship to the user inferred from this encounter's context */
    relationship: string | null;
    /** Focus-weight of the material the person was seen in [0, 1]. Higher = user paid more attention. */
    weight: number | null;
    /** Detector confidence 0–1 */
    confidence: number;
    /** Detection timestamp (ms) */
    timestamp: number;
    /** Optional identifier of the observation that produced this encounter */
    detectorEventId: string | null;
}

/**
 * Aggregated view of a person built from all their encounters.
 * Returned by getPersonProfile() — not stored directly.
 */
export interface PersonProfile extends Person {
    /** Most recently seen role (from most recent encounter that had one) */
    currentRole: string | null;
    /** Most recently seen company */
    currentCompany: string | null;
    /** Most recently inferred relationship to the user */
    currentRelationship: string | null;
    /** All distinct email addresses ever seen, newest first */
    allEmails: string[];
    /** All distinct handles ever seen, newest first */
    allHandles: string[];
    /** All distinct companies ever seen, newest first */
    allCompanies: string[];
}
