/**
 * Memory Store — SQLite-backed persistent storage for materials, frames,
 * and future content from various producers (material-manager, clipboard,
 * screenshots, etc.).
 *
 * Instantiated by the runtime and shared across content producers.
 * Material-manager emits events that the runtime forwards to Memory for storage.
 *
 * Uses better-sqlite3 for synchronous, high-performance access.
 *
 * Schema:
 *   materials — one row per material (title/tab within a window)
 *   frames    — one row per curated frame, with JPEG blob
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Material, MaterialFrame, Screenshot, Task, TaskEvent, Person, PersonEncounter, PersonProfile } from './types';

/** Accumulated OCR text for a material (merged across all processed frames). */
export interface MaterialOcrResult {
    materialId: string;
    /** Deduplicated OCR text, one recognized line per row. */
    text: string;
    lineCount: number;
    /** Total number of frames OCRed for this material so far. */
    frameCount: number;
    /** Timestamp of the newest frame already processed (incremental cursor). */
    lastFrameTs: number;
    updatedAt: number;
}

// ── Configuration ─────────────────────────────────────────────────────────

export interface MemoryStoreConfig {
    /** Path to the SQLite database file. Default: ':memory:' */
    dbPath?: string;
    /** Max frames to retain per material before oldest are evicted. Default: 200 */
    maxFramesPerMaterial?: number;
    /** Enable WAL mode for better concurrent performance. Default: true */
    walMode?: boolean;
}

const DEFAULTS: Required<MemoryStoreConfig> = {
    dbPath: ':memory:',
    maxFramesPerMaterial: 200,
    walMode: true,
};

// ── Memory Store ───────────────────────────────────────────────────────────

export class MemoryStore {
    private db: Database.Database;
    private config: Required<MemoryStoreConfig>;

    // Prepared statements (cached for performance)
    private stmtInsertMaterial!: Database.Statement;
    private stmtUpdateMaterial!: Database.Statement;
    private stmtUpdateMaterialType!: Database.Statement;
    private stmtGetMaterial!: Database.Statement;
    private stmtInsertFrame!: Database.Statement;
    private stmtGetFrames!: Database.Statement;
    private stmtGetFramesMeta!: Database.Statement;
    private stmtGetLatestFrame!: Database.Statement;
    private stmtGetFrameCount!: Database.Statement;
    private stmtGetFrameById!: Database.Statement;
    private stmtDeleteOldFrames!: Database.Statement;
    private stmtGetFramesByWindow!: Database.Statement;
    private stmtGetFramesByWindowMeta!: Database.Statement;
    private stmtGetAllMaterials!: Database.Statement;
    private stmtInsertScreenshot!: Database.Statement;
    private stmtGetScreenshot!: Database.Statement;
    private stmtGetScreenshots!: Database.Statement;
    private stmtGetScreenshotsMeta!: Database.Statement;
    private stmtUpsertTask!: Database.Statement;
    private stmtInsertTaskEvent!: Database.Statement;
    private stmtGetTasks!: Database.Statement;
    private stmtGetTasksByLevel!: Database.Statement;
    private stmtGetTaskHistory!: Database.Statement;
    private stmtGetRecentTaskEvents!: Database.Statement;
    private stmtGetChildTasks!: Database.Statement;
    private stmtInsertPerson!: Database.Statement;
    private stmtUpdatePersonOnEncounter!: Database.Statement;
    private stmtGetPersonById!: Database.Statement;
    private stmtDedupeByEmail!: Database.Statement;
    private stmtDedupeByNameCompany!: Database.Statement;
    private stmtDedupeByName!: Database.Statement;
    private stmtDedupeByPartialNameWithContext!: Database.Statement;
    private stmtFindByPartialName!: Database.Statement;
    private stmtUpdatePersonName!: Database.Statement;
    private stmtUpdatePersonRelationship!: Database.Statement;
    private stmtUpdatePersonWeight!: Database.Statement;
    private stmtGetAllPersonEncounterWeights!: Database.Statement;
    private stmtInsertPersonEncounter!: Database.Statement;
    private stmtGetPersons!: Database.Statement;
    private stmtGetPersonEncounters!: Database.Statement;
    private stmtGetPersonProfile!: Database.Statement;
    private stmtInsertFocusSession!: Database.Statement;
    private stmtAccumulateMaterialTime!: Database.Statement;
    private stmtGetMaterialTotalTime!: Database.Statement;
    private stmtGetFocusSessions!: Database.Statement;
    private stmtGetAllFocusSessions!: Database.Statement;

    private stmtUpsertMaterialEmbedding!: Database.Statement;
    private stmtSearchByVector!: Database.Statement;

    private stmtGetFramesSince!: Database.Statement;
    private stmtGetMaterialOcr!: Database.Statement;
    private stmtUpsertMaterialOcr!: Database.Statement;

    constructor(config: MemoryStoreConfig = {}) {
        this.config = { ...DEFAULTS, ...config };
        this.db = new Database(this.config.dbPath);

        sqliteVec.load(this.db);

        if (this.config.walMode) {
            this.db.pragma('journal_mode = WAL');
        }
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -64000'); // 64MB cache

        this.createTables();
        this.createIndexes();
        this.prepareStatements();
    }

    private createTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS materials (
                material_id   TEXT PRIMARY KEY,
                title         TEXT NOT NULL,
                window_id     INTEGER NOT NULL,
                application   TEXT,
                bundle_id     TEXT,
                document_path TEXT,
                last_frame_hash TEXT,
                first_seen    INTEGER NOT NULL,
                last_seen     INTEGER NOT NULL,
                material_type TEXT,
                material_type_confidence REAL
            );

            CREATE TABLE IF NOT EXISTS frames (
                frame_id      TEXT PRIMARY KEY,
                material_id   TEXT NOT NULL,
                window_id     INTEGER NOT NULL,
                timestamp     INTEGER NOT NULL,
                width         INTEGER NOT NULL,
                height        INTEGER NOT NULL,
                data          BLOB NOT NULL,
                hash          TEXT,
                title         TEXT,
                application   TEXT,
                bundle_id     TEXT,
                capture_reason TEXT,
                FOREIGN KEY (material_id) REFERENCES materials(material_id)
            );

            CREATE TABLE IF NOT EXISTS screenshots (
                screenshot_id     TEXT PRIMARY KEY,
                timestamp         INTEGER NOT NULL,
                width             INTEGER NOT NULL,
                height            INTEGER NOT NULL,
                data              BLOB NOT NULL,
                mime_type         TEXT NOT NULL DEFAULT 'image/jpeg',
                bounds_x          REAL,
                bounds_y          REAL,
                bounds_w          REAL,
                bounds_h          REAL,
                screenshot_type   TEXT
            );

            CREATE TABLE IF NOT EXISTS tasks (
                task_id        TEXT PRIMARY KEY,
                label          TEXT NOT NULL,
                description    TEXT,
                application    TEXT,
                confidence     REAL,
                status         TEXT NOT NULL DEFAULT 'TASK_DETECTED',
                approach       TEXT,
                parent_task_id TEXT,
                level          TEXT NOT NULL DEFAULT 'leaf',
                first_seen     INTEGER NOT NULL,
                last_seen      INTEGER NOT NULL,
                created_at     INTEGER NOT NULL,
                updated_at     INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS task_events (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id        TEXT,
                task_id         TEXT NOT NULL,
                parent_task_id  TEXT,
                status          TEXT NOT NULL,
                label           TEXT,
                description     TEXT,
                application     TEXT,
                confidence      REAL,
                approach        TEXT,
                level           TEXT,
                timestamp       INTEGER NOT NULL,
                request_ts      INTEGER,
                response_ts     INTEGER,
                created_at      INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS persons (
                person_id       TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                notes           TEXT,
                relationship    TEXT,
                weight          REAL,
                first_seen      INTEGER NOT NULL,
                last_seen       INTEGER NOT NULL,
                encounter_count INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS person_encounters (
                encounter_id        TEXT PRIMARY KEY,
                person_id           TEXT NOT NULL,
                context             TEXT NOT NULL,
                platform            TEXT,
                application         TEXT,
                role                TEXT,
                company             TEXT,
                email               TEXT,
                handle              TEXT,
                relationship        TEXT,
                weight              REAL,
                confidence          REAL NOT NULL,
                timestamp           INTEGER NOT NULL,
                detector_event_id   TEXT,
                FOREIGN KEY (person_id) REFERENCES persons(person_id)
            );

            CREATE TABLE IF NOT EXISTS material_focus_sessions (
                session_id   TEXT PRIMARY KEY,
                material_id  TEXT NOT NULL,
                started_at   INTEGER NOT NULL,
                ended_at     INTEGER NOT NULL,
                duration_ms  INTEGER NOT NULL,
                FOREIGN KEY (material_id) REFERENCES materials(material_id)
            );

            CREATE TABLE IF NOT EXISTS material_ocr_results (
                material_id     TEXT PRIMARY KEY,
                text            TEXT NOT NULL,
                line_count      INTEGER NOT NULL,
                frame_count     INTEGER NOT NULL DEFAULT 0,
                last_frame_ts   INTEGER NOT NULL DEFAULT 0,
                updated_at      INTEGER NOT NULL,
                FOREIGN KEY (material_id) REFERENCES materials(material_id)
            );
        `);

        // Migration: add total_time_ms to existing materials tables that predate this column.
        try {
            this.db.exec(`ALTER TABLE materials ADD COLUMN total_time_ms INTEGER NOT NULL DEFAULT 0`);
        } catch { /* column already exists */ }

        // Migration: add relationship columns added after initial schema.
        try {
            this.db.exec(`ALTER TABLE persons ADD COLUMN relationship TEXT`);
        } catch { /* column already exists */ }
        try {
            this.db.exec(`ALTER TABLE persons ADD COLUMN weight REAL`);
        } catch { /* column already exists */ }
        try {
            this.db.exec(`ALTER TABLE person_encounters ADD COLUMN relationship TEXT`);
        } catch { /* column already exists */ }
        try {
            this.db.exec(`ALTER TABLE person_encounters ADD COLUMN weight REAL`);
        } catch { /* column already exists */ }

        // Migration: add app_metadata_json for application-specific structured metadata.
        try {
            this.db.exec(`ALTER TABLE materials ADD COLUMN app_metadata_json TEXT`);
        } catch { /* column already exists */ }

        // Vector search table for semantic material search (384-dim from all-MiniLM-L6-v2).
        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS material_embeddings USING vec0(
                embedding float[384]
            );
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS material_embedding_map (
                material_id TEXT PRIMARY KEY,
                vec_rowid   INTEGER NOT NULL UNIQUE
            );
        `);
    }

    private createIndexes(): void {
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_materials_window
                ON materials(window_id);

            CREATE INDEX IF NOT EXISTS idx_frames_material
                ON frames(material_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_frames_window
                ON frames(window_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_frames_timestamp
                ON frames(timestamp);

            CREATE INDEX IF NOT EXISTS idx_screenshots_timestamp
                ON screenshots(timestamp);

            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_last_seen ON tasks(last_seen DESC);
            CREATE INDEX IF NOT EXISTS idx_tasks_application ON tasks(application);
            CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_level ON tasks(level);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_event_id
                ON task_events(event_id) WHERE event_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
            CREATE INDEX IF NOT EXISTS idx_task_events_parent ON task_events(parent_task_id);
            CREATE INDEX IF NOT EXISTS idx_task_events_timestamp ON task_events(timestamp DESC);

            CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(name);
            CREATE INDEX IF NOT EXISTS idx_persons_last_seen ON persons(last_seen DESC);

            CREATE INDEX IF NOT EXISTS idx_focus_sessions_material
                ON material_focus_sessions(material_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_focus_sessions_started
                ON material_focus_sessions(started_at DESC);

            CREATE INDEX IF NOT EXISTS idx_person_encounters_person ON person_encounters(person_id, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_person_encounters_timestamp ON person_encounters(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_person_encounters_email ON person_encounters(email) WHERE email IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_person_encounters_company ON person_encounters(company) WHERE company IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_person_encounters_detector_event
                ON person_encounters(detector_event_id) WHERE detector_event_id IS NOT NULL;
        `);
    }

    private prepareStatements(): void {
        this.stmtInsertMaterial = this.db.prepare(`
            INSERT INTO materials
                (material_id, title, window_id, application, bundle_id,
                 document_path, last_frame_hash, first_seen, last_seen,
                 material_type, material_type_confidence, app_metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(material_id) DO UPDATE SET
                title = excluded.title,
                window_id = excluded.window_id,
                application = excluded.application,
                bundle_id = excluded.bundle_id,
                document_path = COALESCE(excluded.document_path, document_path),
                last_frame_hash = COALESCE(excluded.last_frame_hash, last_frame_hash),
                last_seen = MAX(excluded.last_seen, last_seen),
                material_type = COALESCE(excluded.material_type, material_type),
                material_type_confidence = COALESCE(excluded.material_type_confidence, material_type_confidence),
                app_metadata_json = COALESCE(excluded.app_metadata_json, app_metadata_json)
        `);

        this.stmtUpdateMaterial = this.db.prepare(`
            UPDATE materials SET
                last_frame_hash = ?,
                last_seen = ?,
                document_path = COALESCE(?, document_path)
            WHERE material_id = ?
        `);

        this.stmtUpdateMaterialType = this.db.prepare(`
            UPDATE materials SET
                material_type = ?,
                material_type_confidence = ?
            WHERE material_id = ?
        `);

        this.stmtGetMaterial = this.db.prepare(`
            SELECT * FROM materials WHERE material_id = ?
        `);

        this.stmtInsertFrame = this.db.prepare(`
            INSERT INTO frames
                (frame_id, material_id, window_id, timestamp, width, height,
                 data, hash, title, application, bundle_id, capture_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this.stmtGetFrames = this.db.prepare(`
            SELECT * FROM frames
            WHERE material_id = ?
            ORDER BY timestamp ASC
        `);

        this.stmtGetFramesSince = this.db.prepare(`
            SELECT * FROM frames
            WHERE material_id = ? AND timestamp > ?
            ORDER BY timestamp ASC
            LIMIT ?
        `);

        this.stmtGetMaterialOcr = this.db.prepare(`
            SELECT * FROM material_ocr_results WHERE material_id = ?
        `);

        this.stmtUpsertMaterialOcr = this.db.prepare(`
            INSERT INTO material_ocr_results
                (material_id, text, line_count, frame_count, last_frame_ts, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(material_id) DO UPDATE SET
                text = excluded.text,
                line_count = excluded.line_count,
                frame_count = excluded.frame_count,
                last_frame_ts = excluded.last_frame_ts,
                updated_at = excluded.updated_at
        `);

        this.stmtGetFramesMeta = this.db.prepare(`
            SELECT frame_id, material_id, window_id, timestamp, width, height,
                   hash, title, application, bundle_id, capture_reason
            FROM frames
            WHERE material_id = ?
            ORDER BY timestamp ASC
        `);

        this.stmtGetLatestFrame = this.db.prepare(`
            SELECT * FROM frames
            WHERE material_id = ?
            ORDER BY timestamp DESC
            LIMIT 1
        `);

        this.stmtGetFrameCount = this.db.prepare(`
            SELECT COUNT(*) as count FROM frames WHERE material_id = ?
        `);

        this.stmtGetFrameById = this.db.prepare(`
            SELECT * FROM frames WHERE frame_id = ?
        `);

        this.stmtDeleteOldFrames = this.db.prepare(`
            DELETE FROM frames
            WHERE frame_id IN (
                SELECT frame_id FROM frames
                WHERE material_id = ?
                ORDER BY timestamp ASC
                LIMIT ?
            )
        `);

        this.stmtGetFramesByWindow = this.db.prepare(`
            SELECT * FROM frames
            WHERE window_id = ?
            ORDER BY timestamp ASC
        `);

        this.stmtGetFramesByWindowMeta = this.db.prepare(`
            SELECT frame_id, material_id, window_id, timestamp, width, height,
                   hash, title, application, bundle_id, capture_reason
            FROM frames
            WHERE window_id = ?
            ORDER BY timestamp ASC
        `);

        this.stmtGetAllMaterials = this.db.prepare(`
            SELECT * FROM materials
            ORDER BY last_seen DESC
        `);

        this.stmtInsertScreenshot = this.db.prepare(`
            INSERT OR REPLACE INTO screenshots
                (screenshot_id, timestamp, width, height, data, mime_type,
                 bounds_x, bounds_y, bounds_w, bounds_h, screenshot_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this.stmtGetScreenshot = this.db.prepare(`
            SELECT * FROM screenshots WHERE screenshot_id = ?
        `);

        this.stmtGetScreenshots = this.db.prepare(`
            SELECT * FROM screenshots
            WHERE timestamp >= ?
            ORDER BY timestamp DESC
            LIMIT ?
        `);

        this.stmtGetScreenshotsMeta = this.db.prepare(`
            SELECT screenshot_id, timestamp, width, height, mime_type,
                   bounds_x, bounds_y, bounds_w, bounds_h, screenshot_type
            FROM screenshots
            WHERE timestamp >= ?
            ORDER BY timestamp DESC
            LIMIT ?
        `);

        this.stmtUpsertTask = this.db.prepare(`
            INSERT INTO tasks (task_id, label, description, application, confidence, status, approach, parent_task_id, level, first_seen, last_seen, created_at, updated_at)
            VALUES (@task_id, @label, @description, @application, @confidence, @status, @approach, @parent_task_id, @level, @ts, @ts, @now, @now)
            ON CONFLICT(task_id) DO UPDATE SET
                label          = COALESCE(@label, tasks.label),
                description    = COALESCE(@description, tasks.description),
                application    = COALESCE(@application, tasks.application),
                confidence     = COALESCE(@confidence, tasks.confidence),
                status         = COALESCE(@status, tasks.status),
                approach       = COALESCE(@approach, tasks.approach),
                parent_task_id = COALESCE(@parent_task_id, tasks.parent_task_id),
                level          = COALESCE(@level, tasks.level),
                last_seen      = MAX(tasks.last_seen, @ts),
                updated_at     = @now
        `);

        this.stmtInsertTaskEvent = this.db.prepare(`
            INSERT OR IGNORE INTO task_events (event_id, task_id, parent_task_id, status, label, description, application, confidence, approach, level, timestamp, request_ts, response_ts, created_at)
            VALUES (@event_id, @task_id, @parent_task_id, @status, @label, @description, @application, @confidence, @approach, @level, @timestamp, @request_ts, @response_ts, @created_at)
        `);

        this.stmtGetTasks = this.db.prepare(`
            SELECT * FROM tasks ORDER BY last_seen DESC LIMIT ?
        `);

        this.stmtGetTaskHistory = this.db.prepare(`
            SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp DESC LIMIT ?
        `);

        this.stmtGetRecentTaskEvents = this.db.prepare(`
            SELECT * FROM task_events ORDER BY timestamp DESC LIMIT ?
        `);

        this.stmtGetTasksByLevel = this.db.prepare(`
            SELECT * FROM tasks WHERE level = ? ORDER BY last_seen DESC LIMIT ?
        `);

        this.stmtGetChildTasks = this.db.prepare(`
            SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY last_seen DESC LIMIT ?
        `);

        this.stmtInsertPerson = this.db.prepare(`
            INSERT INTO persons (person_id, name, notes, relationship, weight, first_seen, last_seen, encounter_count)
            VALUES (@person_id, @name, NULL, @relationship, @weight, @ts, @ts, 1)
        `);

        this.stmtUpdatePersonOnEncounter = this.db.prepare(`
            UPDATE persons SET
                last_seen       = MAX(@ts, last_seen),
                encounter_count = encounter_count + 1
            WHERE person_id = @person_id
        `);

        this.stmtGetPersonById = this.db.prepare(`SELECT * FROM persons WHERE person_id = ?`);

        // Dedup tier 1: email match — join persons so we also get the stored name
        this.stmtDedupeByEmail = this.db.prepare(`
            SELECT pe.person_id, p.name FROM person_encounters pe
            JOIN persons p ON p.person_id = pe.person_id
            WHERE pe.email = ? COLLATE NOCASE LIMIT 1
        `);

        // Dedup tier 2: name + company (join needed since name is on persons)
        this.stmtDedupeByNameCompany = this.db.prepare(`
            SELECT p.person_id, p.name FROM persons p
            INNER JOIN person_encounters pe ON p.person_id = pe.person_id
            WHERE p.name = ? COLLATE NOCASE AND pe.company = ? COLLATE NOCASE
            LIMIT 1
        `);

        // Dedup tier 3: name alone (case-insensitive)
        this.stmtDedupeByName = this.db.prepare(`
            SELECT person_id, name FROM persons WHERE name = ? COLLATE NOCASE LIMIT 1
        `);

        // Dedup tier 4: one name is a prefix of the other (e.g. "Julie" ↔ "Julie Conner")
        // with at least one shared contextual attribute (platform, company, or application).
        // SQLite LIKE is already case-insensitive for ASCII; = needs explicit COLLATE NOCASE.
        this.stmtDedupeByPartialNameWithContext = this.db.prepare(`
            SELECT DISTINCT p.person_id, p.name FROM persons p
            JOIN person_encounters pe ON p.person_id = pe.person_id
            WHERE (
                p.name LIKE @name || ' %'
                OR @name LIKE p.name || ' %'
            )
            AND (
                (@platform    IS NOT NULL AND pe.platform    = @platform    COLLATE NOCASE)
                OR (@company  IS NOT NULL AND pe.company     = @company     COLLATE NOCASE)
                OR (@app      IS NOT NULL AND pe.application = @app         COLLATE NOCASE)
            )
            LIMIT 1
        `);

        // Dedup tier 5: prefix match alone — only safe when the match is unambiguous
        // (exactly one person in the network shares that first name).
        this.stmtFindByPartialName = this.db.prepare(`
            SELECT person_id, name FROM persons
            WHERE name LIKE @name || ' %'
               OR @name LIKE name || ' %'
        `);

        // Upgrade a stored partial name to a fuller one (e.g. "Julie" → "Julie Conner")
        this.stmtUpdatePersonName = this.db.prepare(`
            UPDATE persons SET name = @name WHERE person_id = @person_id
        `);

        this.stmtUpdatePersonRelationship = this.db.prepare(`
            UPDATE persons SET relationship = @relationship WHERE person_id = @person_id
        `);

        this.stmtUpdatePersonWeight = this.db.prepare(`
            UPDATE persons SET weight = @weight WHERE person_id = @person_id
        `);

        this.stmtGetAllPersonEncounterWeights = this.db.prepare(`
            SELECT person_id, weight, timestamp FROM person_encounters
            WHERE weight IS NOT NULL
            ORDER BY person_id, timestamp DESC
        `);

        this.stmtInsertPersonEncounter = this.db.prepare(`
            INSERT OR IGNORE INTO person_encounters
                (encounter_id, person_id, context, platform, application,
                 role, company, email, handle, relationship, weight, confidence, timestamp, detector_event_id)
            VALUES
                (@encounter_id, @person_id, @context, @platform, @application,
                 @role, @company, @email, @handle, @relationship, @weight, @confidence, @timestamp, @detector_event_id)
        `);

        this.stmtInsertFocusSession = this.db.prepare(`
            INSERT OR IGNORE INTO material_focus_sessions
                (session_id, material_id, started_at, ended_at, duration_ms)
            VALUES (@session_id, @material_id, @started_at, @ended_at, @duration_ms)
        `);

        this.stmtAccumulateMaterialTime = this.db.prepare(`
            UPDATE materials
            SET total_time_ms = total_time_ms + @duration_ms
            WHERE material_id = @material_id
        `);

        this.stmtGetMaterialTotalTime = this.db.prepare(`
            SELECT total_time_ms FROM materials WHERE material_id = ?
        `);

        this.stmtGetFocusSessions = this.db.prepare(`
            SELECT * FROM material_focus_sessions
            WHERE material_id = ?
            ORDER BY started_at DESC
            LIMIT ?
        `);

        this.stmtGetAllFocusSessions = this.db.prepare(`
            SELECT material_id, started_at, duration_ms FROM material_focus_sessions
        `);

        this.stmtGetPersons = this.db.prepare(`SELECT * FROM persons ORDER BY last_seen DESC LIMIT ?`);

        this.stmtGetPersonEncounters = this.db.prepare(`
            SELECT * FROM person_encounters WHERE person_id = ? ORDER BY timestamp DESC LIMIT ?
        `);

        // Aggregated profile: latest role/company + all distinct emails, handles, companies
        this.stmtGetPersonProfile = this.db.prepare(`
            SELECT
                p.person_id, p.name, p.notes, p.relationship, p.first_seen, p.last_seen, p.encounter_count,
                (SELECT role         FROM person_encounters WHERE person_id = p.person_id AND role         IS NOT NULL ORDER BY timestamp DESC LIMIT 1) AS current_role,
                (SELECT company      FROM person_encounters WHERE person_id = p.person_id AND company      IS NOT NULL ORDER BY timestamp DESC LIMIT 1) AS current_company,
                (SELECT relationship FROM person_encounters WHERE person_id = p.person_id AND relationship IS NOT NULL ORDER BY timestamp DESC LIMIT 1) AS current_relationship,
                GROUP_CONCAT(DISTINCT pe.email)   AS all_emails,
                GROUP_CONCAT(DISTINCT pe.handle)  AS all_handles,
                GROUP_CONCAT(DISTINCT pe.company) AS all_companies
            FROM persons p
            LEFT JOIN person_encounters pe ON p.person_id = pe.person_id
            WHERE p.person_id = ?
            GROUP BY p.person_id
        `);

        this.stmtUpsertMaterialEmbedding = this.db.prepare(`
            INSERT INTO material_embeddings (embedding) VALUES (?)
        `);

        this.stmtSearchByVector = this.db.prepare(`
            SELECT m.rowid, m.distance, em.material_id
            FROM material_embeddings m
            JOIN material_embedding_map em ON em.vec_rowid = m.rowid
            WHERE m.embedding MATCH @query AND k = @limit
            ORDER BY m.distance
        `);
    }

    // ── Material operations ───────────────────────────────────────────────

    saveMaterial(material: Material): void {
        this.stmtInsertMaterial.run(
            material.materialId,
            material.title,
            material.windowId,
            material.application,
            material.bundleId,
            material.documentPath,
            material.lastFrameHash,
            material.firstSeen,
            material.lastSeen,
            material.materialType ?? null,
            material.materialTypeConfidence ?? null,
            material.appMetadata ? JSON.stringify(material.appMetadata) : null,
        );
    }

    updateMaterialType(
        materialId: string,
        materialType: string,
        materialTypeConfidence: number,
    ): void {
        this.stmtUpdateMaterialType.run(
            materialType,
            materialTypeConfidence,
            materialId,
        );
    }

    updateMaterial(
        materialId: string,
        lastFrameHash: string | null,
        lastSeen: number,
        documentPath?: string | null,
    ): void {
        this.stmtUpdateMaterial.run(
            lastFrameHash,
            lastSeen,
            documentPath ?? null,
            materialId,
        );
    }

    getMaterial(materialId: string): Material | null {
        const row = this.stmtGetMaterial.get(materialId) as Record<string, unknown> | undefined;
        if (!row) return null;
        const m = this.rowToMaterial(row);
        const weights = this.computeAllMaterialWeights();
        m.weight = weights[m.materialId] ?? null;
        return m;
    }

    getAllMaterials(): Material[] {
        const rows = this.stmtGetAllMaterials.all() as Record<string, unknown>[];
        const weights = this.computeAllMaterialWeights();
        return rows.map((r) => {
            const m = this.rowToMaterial(r);
            m.weight = weights[m.materialId] ?? null;
            return m;
        });
    }

    /**
     * Search materials by keyword across title, application, document_path,
     * and app_metadata_json. Each keyword must appear in at least one field.
     * Results are ordered by weight DESC (heaviest first), then last_seen DESC.
     */
    searchMaterials(query: string, limit = 20): Material[] {
        const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (keywords.length === 0) return [];

        const conditions = keywords.map((_, i) => `(
            LOWER(title) LIKE @kw${i}
            OR LOWER(COALESCE(application, '')) LIKE @kw${i}
            OR LOWER(COALESCE(document_path, '')) LIKE @kw${i}
            OR LOWER(COALESCE(app_metadata_json, '')) LIKE @kw${i}
        )`);

        const sql = `SELECT * FROM materials WHERE ${conditions.join(' AND ')} ORDER BY last_seen DESC LIMIT @limit`;
        const params: Record<string, unknown> = { limit };
        for (let i = 0; i < keywords.length; i++) {
            params[`kw${i}`] = `%${keywords[i]}%`;
        }

        const rows = this.db.prepare(sql).all(params) as Record<string, unknown>[];
        const weights = this.computeAllMaterialWeights();
        const results = rows.map((r) => {
            const m = this.rowToMaterial(r);
            m.weight = weights[m.materialId] ?? null;
            return m;
        });
        results.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
        return results;
    }

    // ── Vector embedding operations ────────────────────────────────────────

    /**
     * Build the text string that gets embedded for a given material.
     * Concat title + application + documentPath + url/hostname from appMetadata.
     */
    static buildEmbeddingText(material: { title: string; application?: string | null; documentPath?: string | null; appMetadata?: Record<string, unknown> | null; appMetadataJson?: string | null }): string {
        const parts: string[] = [material.title];
        if (material.application) parts.push(material.application);
        if (material.documentPath) parts.push(material.documentPath);

        let meta = material.appMetadata as Record<string, unknown> | null;
        if (!meta && material.appMetadataJson) {
            try { meta = JSON.parse(material.appMetadataJson as string); } catch { /* ignore */ }
        }
        if (meta) {
            if (meta.url) parts.push(String(meta.url));
            if (meta.hostname) parts.push(String(meta.hostname));
            if (meta.filename) parts.push(String(meta.filename));
        }
        return parts.join(' | ');
    }

    /**
     * Store (or update) a material's embedding vector.
     * The Float32Array must be 384-dimensional.
     */
    saveMaterialEmbedding(materialId: string, embedding: Float32Array): void {
        const existing = this.db.prepare(
            `SELECT vec_rowid FROM material_embedding_map WHERE material_id = ?`
        ).get(materialId) as { vec_rowid: number | bigint } | undefined;

        const embBuffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

        // vec0 requires BigInt rowid; simplest path is to let SQLite auto-assign
        // via INSERT without rowid, then record the generated rowid in our map.
        if (existing) {
            this.db.prepare(`DELETE FROM material_embeddings WHERE rowid = ?`).run(existing.vec_rowid);
            this.db.prepare(`DELETE FROM material_embedding_map WHERE material_id = ?`).run(materialId);
        }

        const info = this.stmtUpsertMaterialEmbedding.run(embBuffer);
        const newVecRowid = info.lastInsertRowid;

        this.db.prepare(
            `INSERT INTO material_embedding_map (material_id, vec_rowid) VALUES (?, ?)`
        ).run(materialId, newVecRowid);
    }

    /**
     * KNN search by embedding vector. Returns materialIds sorted by similarity.
     */
    searchMaterialsByVector(queryEmbedding: Float32Array, limit = 10): Array<{ materialId: string; distance: number }> {
        const rows = this.stmtSearchByVector.all({
            query: Buffer.from(queryEmbedding.buffer),
            limit,
        }) as Array<{ material_id: string; distance: number }>;

        return rows.map(r => ({ materialId: r.material_id, distance: r.distance }));
    }

    /**
     * Semantic search: find materials by vector similarity, then enrich with full Material data.
     */
    searchMaterialsSemantic(queryEmbedding: Float32Array, limit = 10): Material[] {
        const hits = this.searchMaterialsByVector(queryEmbedding, limit);
        if (hits.length === 0) return [];

        const weights = this.computeAllMaterialWeights();
        const results: Material[] = [];
        for (const hit of hits) {
            const row = this.stmtGetMaterial.get(hit.materialId) as Record<string, unknown> | undefined;
            if (!row) continue;
            const m = this.rowToMaterial(row);
            m.weight = weights[m.materialId] ?? null;
            results.push(m);
        }
        return results;
    }

    /**
     * Returns the number of materials that have embeddings stored.
     */
    getEmbeddingCount(): number {
        return ((this.db.prepare(`SELECT COUNT(*) as cnt FROM material_embedding_map`).get() as { cnt: number }).cnt);
    }

    /**
     * Returns materialIds that have no embedding yet.
     */
    getMaterialsWithoutEmbeddings(limit = 100): string[] {
        const rows = this.db.prepare(`
            SELECT m.material_id FROM materials m
            LEFT JOIN material_embedding_map em ON m.material_id = em.material_id
            WHERE em.material_id IS NULL
            ORDER BY m.last_seen DESC
            LIMIT ?
        `).all(limit) as Array<{ material_id: string }>;
        return rows.map(r => r.material_id);
    }

    // ── Frame operations ──────────────────────────────────────────────────

    /**
     * Store a frame from material-manager (or other producer) and evict old
     * frames if over the per-material budget. Returns the number of frames evicted.
     */
    addFrame(frame: MaterialFrame, hash: string): number {
        this.stmtInsertFrame.run(
            frame.frameId,
            frame.materialId,
            frame.windowId,
            frame.timestamp,
            frame.width,
            frame.height,
            frame.data,
            hash,
            frame.title,
            frame.application,
            frame.bundleId,
            frame.captureReason ?? 'UNKNOWN',
        );

        this.stmtUpdateMaterial.run(
            hash,
            frame.timestamp,
            null,
            frame.materialId,
        );

        return this.evictOldFrames(frame.materialId);
    }

    getFrames(materialId: string): MaterialFrame[] {
        const rows = this.stmtGetFrames.all(materialId) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrame(r));
    }

    /** Get frames newer than a timestamp (ascending), capped at `limit`. Used by OCR. */
    getFramesSince(materialId: string, sinceTs: number, limit = 40): MaterialFrame[] {
        const rows = this.stmtGetFramesSince.all(materialId, sinceTs, limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrame(r));
    }

    getFramesMeta(materialId: string): Omit<MaterialFrame, 'data'>[] {
        const rows = this.stmtGetFramesMeta.all(materialId) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrameMeta(r));
    }

    getFramesByWindow(windowId: number): MaterialFrame[] {
        const rows = this.stmtGetFramesByWindow.all(windowId) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrame(r));
    }

    getFramesByWindowMeta(windowId: number): Omit<MaterialFrame, 'data'>[] {
        const rows = this.stmtGetFramesByWindowMeta.all(windowId) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrameMeta(r));
    }

    getLatestFrame(materialId: string): MaterialFrame | null {
        const row = this.stmtGetLatestFrame.get(materialId) as Record<string, unknown> | undefined;
        return row ? this.rowToFrame(row) : null;
    }

    getFrameById(frameId: string): MaterialFrame | null {
        const row = this.stmtGetFrameById.get(frameId) as Record<string, unknown> | undefined;
        return row ? this.rowToFrame(row) : null;
    }

    getFrameCount(materialId: string): number {
        const row = this.stmtGetFrameCount.get(materialId) as { count: number };
        return row.count;
    }

    getFrameCountByWindow(windowId: number): number {
        const row = this.db
            .prepare('SELECT COUNT(*) as count FROM frames WHERE window_id = ?')
            .get(windowId) as { count: number };
        return row.count;
    }

    // ── OCR results ─────────────────────────────────────────────────────

    getMaterialOcr(materialId: string): MaterialOcrResult | null {
        const row = this.stmtGetMaterialOcr.get(materialId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            materialId: row.material_id as string,
            text: row.text as string,
            lineCount: row.line_count as number,
            frameCount: row.frame_count as number,
            lastFrameTs: row.last_frame_ts as number,
            updatedAt: row.updated_at as number,
        };
    }

    upsertMaterialOcr(result: Omit<MaterialOcrResult, 'updatedAt'>): void {
        this.stmtUpsertMaterialOcr.run(
            result.materialId,
            result.text,
            result.lineCount,
            result.frameCount,
            result.lastFrameTs,
            Date.now(),
        );
    }

    evictOldFrames(materialId: string): number {
        const count = this.getFrameCount(materialId);
        const excess = count - this.config.maxFramesPerMaterial;
        if (excess <= 0) return 0;
        const result = this.stmtDeleteOldFrames.run(materialId, excess);
        return result.changes;
    }

    deleteFramesOlderThan(timestampMs: number): number {
        const result = this.db
            .prepare('DELETE FROM frames WHERE timestamp < ?')
            .run(timestampMs);
        return result.changes;
    }

    // ── Screenshot operations ────────────────────────────────────────────

    saveScreenshot(screenshot: Screenshot): void {
        this.stmtInsertScreenshot.run(
            screenshot.screenshotId,
            screenshot.timestamp,
            screenshot.width,
            screenshot.height,
            screenshot.data,
            screenshot.mimeType,
            screenshot.boundsX,
            screenshot.boundsY,
            screenshot.boundsW,
            screenshot.boundsH,
            screenshot.screenshotType,
        );
    }

    getScreenshot(screenshotId: string): Screenshot | null {
        const row = this.stmtGetScreenshot.get(screenshotId) as Record<string, unknown> | undefined;
        return row ? this.rowToScreenshot(row) : null;
    }

    getScreenshots(limit = 50, since = 0): Screenshot[] {
        const rows = this.stmtGetScreenshots.all(since, limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToScreenshot(r));
    }

    getScreenshotsMeta(limit = 50, since = 0): Omit<Screenshot, 'data'>[] {
        const rows = this.stmtGetScreenshotsMeta.all(since, limit) as Record<string, unknown>[];
        return rows.map((r) => ({
            screenshotId: r.screenshot_id as string,
            timestamp: r.timestamp as number,
            width: r.width as number,
            height: r.height as number,
            mimeType: (r.mime_type as string) ?? 'image/jpeg',
            boundsX: (r.bounds_x as number) ?? null,
            boundsY: (r.bounds_y as number) ?? null,
            boundsW: (r.bounds_w as number) ?? null,
            boundsH: (r.bounds_h as number) ?? null,
            screenshotType: (r.screenshot_type as string) ?? null,
        }));
    }

    // ── Task operations ─────────────────────────────────────────────────

    /**
     * Upsert a task and append the raw event in a single transaction.
     * Returns true if the event was new, false if it was a duplicate.
     */
    ingestTaskEvent(event: {
        eventId?: string | null;
        taskId: string;
        taskLabel?: string | null;
        taskDescription?: string | null;
        status?: string | null;
        confidence?: number | null;
        application?: string | null;
        approach?: string | null;
        parentTaskId?: string | null;
        level?: string | null;
        timestamp: number;
        requestTimestamp?: number | null;
        responseTimestamp?: number | null;
    }): boolean {
        const now = Date.now();
        const ts = event.timestamp || now;
        const level = event.level || 'action';

        const txn = this.db.transaction(() => {
            this.stmtUpsertTask.run({
                task_id: event.taskId,
                label: event.taskLabel || 'Unknown task',
                description: event.taskDescription || null,
                application: event.application || null,
                confidence: event.confidence ?? null,
                status: event.status || 'TASK_DETECTED',
                approach: event.approach || null,
                parent_task_id: event.parentTaskId || null,
                level,
                ts,
                now,
            });

            const info = this.stmtInsertTaskEvent.run({
                event_id: event.eventId || null,
                task_id: event.taskId,
                parent_task_id: event.parentTaskId || null,
                status: event.status || 'TASK_DETECTED',
                label: event.taskLabel || null,
                description: event.taskDescription || null,
                application: event.application || null,
                confidence: event.confidence ?? null,
                approach: event.approach || null,
                level,
                timestamp: ts,
                request_ts: event.requestTimestamp ?? null,
                response_ts: event.responseTimestamp ?? null,
                created_at: now,
            });

            return info.changes > 0;
        });

        return txn();
    }

    /** Get deduplicated tasks ordered by last_seen DESC. */
    getTasks(limit = 200): Task[] {
        const rows = this.stmtGetTasks.all(limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToTask(r));
    }

    /** Get raw event history for a specific task. */
    getTaskHistory(taskId: string, limit = 100): TaskEvent[] {
        const rows = this.stmtGetTaskHistory.all(taskId, limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToTaskEvent(r));
    }

    /** Get all raw events, most recent first. */
    getRecentTaskEvents(limit = 500): TaskEvent[] {
        const rows = this.stmtGetRecentTaskEvents.all(limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToTaskEvent(r));
    }

    /** Get tasks filtered by level ('leaf' or 'goal'), ordered by last_seen DESC. */
    getTasksByLevel(level: string, limit = 200): Task[] {
        const rows = this.stmtGetTasksByLevel.all(level, limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToTask(r));
    }

    /** Get child tasks of a parent (goal) task, ordered by last_seen DESC. */
    getChildTasks(parentTaskId: string, limit = 200): Task[] {
        const rows = this.stmtGetChildTasks.all(parentTaskId, limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToTask(r));
    }

    // ── Person / personal-network operations ──────────────────────────────

    /**
     * Record a person encounter in the personal network.
     *
     * Role, company, email, and handle are stored on the encounter row (not on
     * the person), so a person can accumulate multiple values for each over time.
     *
     * Deduplication order:
     *   1. email match across existing encounters (most reliable)
     *   2. name + company match
     *   3. name alone (weakest — only used when nothing else matches)
     *
     * Returns the resolved personId.
     */
    ingestPersonEncounter(encounter: {
        encounterId: string;
        name: string;
        role?: string | null;
        company?: string | null;
        email?: string | null;
        handle?: string | null;
        relationship?: string | null;
        weight?: number | null;
        context: string;
        platform?: string | null;
        application?: string | null;
        confidence: number;
        timestamp: number;
        detectorEventId?: string | null;
    }): { personId: string; isNew: boolean } {
        const ts = encounter.timestamp;
        // Normalize name: trim edges and collapse internal whitespace
        const name = encounter.name.trim().replace(/\s+/g, ' ');

        const txn = this.db.transaction((): { personId: string; isNew: boolean } => {
            // ── Resolve existing person ──────────────────────────────────
            type DedupeRow = { person_id: string; name: string };
            let personId: string | undefined;
            let existingName: string | undefined;

            if (encounter.email) {
                const row = this.stmtDedupeByEmail.get(encounter.email) as DedupeRow | undefined;
                personId = row?.person_id;
                existingName = row?.name;
            }
            if (!personId && encounter.company) {
                const row = this.stmtDedupeByNameCompany.get(name, encounter.company) as DedupeRow | undefined;
                personId = row?.person_id;
                existingName = row?.name;
            }
            if (!personId) {
                const row = this.stmtDedupeByName.get(name) as DedupeRow | undefined;
                personId = row?.person_id;
                existingName = row?.name;
            }

            // Tier 4: prefix match + shared context (e.g. "Julie" seen on Gmail where
            // "Julie Conner" was already recorded from Gmail)
            if (!personId && (encounter.platform || encounter.company || encounter.application)) {
                const row = this.stmtDedupeByPartialNameWithContext.get({
                    name,
                    platform: encounter.platform ?? null,
                    company: encounter.company ?? null,
                    app: encounter.application ?? null,
                }) as DedupeRow | undefined;
                personId = row?.person_id;
                existingName = row?.name;
            }

            // Tier 5: prefix match alone — only use when unambiguous (exactly 1 candidate)
            if (!personId) {
                const candidates = this.stmtFindByPartialName.all({ name }) as DedupeRow[];
                if (candidates.length === 1) {
                    personId = candidates[0].person_id;
                    existingName = candidates[0].name;
                }
            }

            const isNew = !personId;
            const incomingRelationship = encounter.relationship?.trim() || null;
            const incomingWeight = encounter.weight ?? null;

            if (personId) {
                this.stmtUpdatePersonOnEncounter.run({ person_id: personId, ts });

                // Upgrade the stored name when the new one is more complete.
                if (existingName && name.toLowerCase().startsWith(existingName.toLowerCase() + ' ')) {
                    this.stmtUpdatePersonName.run({ person_id: personId, name });
                }

                // NOTE: persons.weight is NOT updated inline — the caller runs
                // recomputeAllPersonWeights() periodically to apply recency-decay
                // across all encounters, mirroring how material weights work.

                // NOTE: relationship on persons is NOT updated here — the caller
                // A downstream consumer synthesises a refined relationship using
                // the LLM after considering all past encounters, then calls
                // updatePersonRelationship() explicitly.
            } else {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { randomUUID } = require('crypto') as typeof import('crypto');
                personId = randomUUID();
                this.stmtInsertPerson.run({ person_id: personId, name, relationship: incomingRelationship, weight: incomingWeight, ts });
            }

            // ── Insert encounter ───
            this.stmtInsertPersonEncounter.run({
                encounter_id: encounter.encounterId,
                person_id: personId,
                context: encounter.context,
                platform: encounter.platform ?? null,
                application: encounter.application ?? null,
                role: encounter.role ?? null,
                company: encounter.company ?? null,
                email: encounter.email ?? null,
                handle: encounter.handle ?? null,
                relationship: incomingRelationship,
                weight: incomingWeight,
                confidence: encounter.confidence,
                timestamp: ts,
                detector_event_id: encounter.detectorEventId ?? null,
            });

            return { personId, isNew };
        });

        return txn();
    }

    /**
     * Explicitly set the synthesised relationship on a person.
     * Called by the client after LLM-based synthesis across all encounters.
     */
    updatePersonRelationship(personId: string, relationship: string): void {
        this.stmtUpdatePersonRelationship.run({ person_id: personId, relationship });
    }

    /** Get a person's aggregated profile: latest role/company + all known emails, handles, companies. */
    getPersonProfile(personId: string): PersonProfile | null {
        const row = this.stmtGetPersonProfile.get(personId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return this.rowToPersonProfile(row);
    }

    getPerson(personId: string): Person | null {
        const row = this.stmtGetPersonById.get(personId) as Record<string, unknown> | undefined;
        return row ? this.rowToPerson(row) : null;
    }

    getPersons(limit = 200): Person[] {
        this.recomputeAllPersonWeights();
        const rows = this.stmtGetPersons.all(limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToPerson(r));
    }

    getPersonEncounters(personId: string, limit = 100): PersonEncounter[] {
        const rows = this.stmtGetPersonEncounters.all(personId, limit) as Record<string, unknown>[];
        return rows.map((r) => this.rowToPersonEncounter(r));
    }

    // ── Focus session operations ──────────────────────────────────────────

    /**
     * Record a completed focus session and atomically add its duration to
     * the material's running total. Both writes are in a single transaction
     * so total_time_ms is always consistent with the session log.
     */
    recordFocusSession(session: {
        sessionId: string;
        materialId: string;
        startedAt: number;
        endedAt: number;
        durationMs: number;
    }): void {
        const txn = this.db.transaction(() => {
            this.stmtInsertFocusSession.run({
                session_id:  session.sessionId,
                material_id: session.materialId,
                started_at:  session.startedAt,
                ended_at:    session.endedAt,
                duration_ms: session.durationMs,
            });
            this.stmtAccumulateMaterialTime.run({
                material_id: session.materialId,
                duration_ms: session.durationMs,
            });
        });
        txn();
    }

    /** Total milliseconds the user has spent on a material across all sessions. */
    getMaterialTotalTime(materialId: string): number {
        const row = this.stmtGetMaterialTotalTime.get(materialId) as { total_time_ms: number } | undefined;
        return row?.total_time_ms ?? 0;
    }

    /**
     * Compute a recency-decayed importance weight [0, 1] for every material
     * that has at least one focus session.
     *
     * Formula (Option B — exponential decay):
     *   decayedMs = Σ duration_ms_i × exp(−λ × age_ms_i)
     *   weight    = min(1, log(1 + decayedHours) / log(1 + REFERENCE_HOURS))
     *
     * where λ = ln(2) / halfLifeMs and REFERENCE_HOURS = 8 (a full work day → ~1.0).
     * A 7-day half-life means yesterday counts at 100%, last week at 50%, last month at ~10%.
     */
    computeAllMaterialWeights(halfLifeDays = 7): Record<string, number> {
        const rows = this.stmtGetAllFocusSessions.all() as Array<{
            material_id: string;
            started_at: number;
            duration_ms: number;
        }>;

        const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
        const lambda = Math.log(2) / halfLifeMs;
        const nowMs = Date.now();
        const REFERENCE_HOURS = 1; // 1 focused hour → weight ≈ 1.0

        // Accumulate decayed score (in ms) per material
        const scores = new Map<string, number>();
        for (const row of rows) {
            const ageMs = nowMs - row.started_at;
            const decay = Math.exp(-lambda * ageMs);
            scores.set(row.material_id, (scores.get(row.material_id) ?? 0) + row.duration_ms * decay);
        }

        // Convert to [0, 1] log-scale weights
        const result: Record<string, number> = {};
        for (const [materialId, scoreMs] of scores) {
            const scoreHours = scoreMs / 3_600_000;
            const w = Math.min(1, Math.log(1 + scoreHours) / Math.log(1 + REFERENCE_HOURS));
            result[materialId] = Math.round(w * 100) / 100;
        }
        return result;
    }

    /**
     * Recompute recency-decayed importance weights for all persons and update
     * persons.weight in place. Mirrors the material weight formula.
     *
     * For persons the "signal" per encounter is the material's focusWeight at
     * detection time (0–1). Each encounter's signal decays exponentially with
     * age, then the sum is log-normalized to [0, 1]:
     *
     *   decayedSignal = Σ encounter_weight_i × exp(−λ × age_ms_i)
     *   personWeight  = min(1, log(1 + decayedSignal) / log(1 + REFERENCE))
     *
     * REFERENCE = 5 means a person who accumulates ~5 units of decayed signal
     * (e.g. 5 encounters in high-weight materials recently) reaches weight ≈ 1.0.
     *
     * Returns the computed weights for callers that need them.
     */
    recomputeAllPersonWeights(halfLifeDays = 7): Record<string, number> {
        const rows = this.stmtGetAllPersonEncounterWeights.all() as Array<{
            person_id: string;
            weight: number;
            timestamp: number;
        }>;

        const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
        const lambda = Math.log(2) / halfLifeMs;
        const nowMs = Date.now();
        const REFERENCE = 1;

        const scores = new Map<string, number>();
        for (const row of rows) {
            const ageMs = nowMs - row.timestamp;
            const decay = Math.exp(-lambda * ageMs);
            scores.set(row.person_id, (scores.get(row.person_id) ?? 0) + row.weight * decay);
        }

        const result: Record<string, number> = {};
        const updateTxn = this.db.transaction(() => {
            for (const [personId, score] of scores) {
                const w = Math.min(1, Math.log(1 + score) / Math.log(1 + REFERENCE));
                const rounded = Math.round(w * 100) / 100;
                result[personId] = rounded;
                this.stmtUpdatePersonWeight.run({ person_id: personId, weight: rounded });
            }
        });
        updateTxn();
        return result;
    }

    /** Recent focus sessions for a material, newest first. */
    getFocusSessions(materialId: string, limit = 100): Array<{
        sessionId: string;
        materialId: string;
        startedAt: number;
        endedAt: number;
        durationMs: number;
    }> {
        const rows = this.stmtGetFocusSessions.all(materialId, limit) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
            sessionId:  r.session_id as string,
            materialId: r.material_id as string,
            startedAt:  r.started_at as number,
            endedAt:    r.ended_at as number,
            durationMs: r.duration_ms as number,
        }));
    }

    getStats(): { materialCount: number; frameCount: number; screenshotCount: number; dbSizeBytes: number } {
        const matRow = this.db
            .prepare('SELECT COUNT(*) as count FROM materials')
            .get() as { count: number };
        const frmRow = this.db
            .prepare('SELECT COUNT(*) as count FROM frames')
            .get() as { count: number };
        const ssRow = this.db
            .prepare('SELECT COUNT(*) as count FROM screenshots')
            .get() as { count: number };
        const pageCount = this.db.pragma('page_count', { simple: true }) as number;
        const pageSize = this.db.pragma('page_size', { simple: true }) as number;
        return {
            materialCount: matRow.count,
            frameCount: frmRow.count,
            screenshotCount: ssRow.count,
            dbSizeBytes: pageCount * pageSize,
        };
    }

    close(): void {
        this.db.close();
    }

    // ── Row mappers ───────────────────────────────────────────────────────

    private rowToMaterial(row: Record<string, unknown>): Material {
        let appMetadata: Record<string, string | null> | null = null;
        const metaJson = row.app_metadata_json as string | null | undefined;
        if (metaJson) {
            try { appMetadata = JSON.parse(metaJson) as Record<string, string | null>; } catch { /* ignore */ }
        }
        return {
            materialId: row.material_id as string,
            title: row.title as string,
            windowId: row.window_id as number,
            application: (row.application as string) ?? null,
            bundleId: (row.bundle_id as string) ?? null,
            documentPath: (row.document_path as string) ?? null,
            lastFrameHash: (row.last_frame_hash as string) ?? null,
            firstSeen: row.first_seen as number,
            lastSeen: row.last_seen as number,
            materialType: (row.material_type as string) ?? null,
            materialTypeConfidence: (row.material_type_confidence as number) ?? null,
            totalTimeMs: (row.total_time_ms as number) ?? 0,
            weight: null,
            appMetadata,
        };
    }

    private rowToFrame(row: Record<string, unknown>): MaterialFrame {
        return {
            frameId: row.frame_id as string,
            materialId: row.material_id as string,
            windowId: row.window_id as number,
            timestamp: row.timestamp as number,
            width: row.width as number,
            height: row.height as number,
            data: row.data as Buffer,
            title: (row.title as string) ?? null,
            application: (row.application as string) ?? null,
            bundleId: (row.bundle_id as string) ?? null,
            captureReason: (row.capture_reason as string) ?? 'UNKNOWN',
        };
    }

    private rowToScreenshot(row: Record<string, unknown>): Screenshot {
        return {
            screenshotId: row.screenshot_id as string,
            timestamp: row.timestamp as number,
            width: row.width as number,
            height: row.height as number,
            data: row.data as Buffer,
            mimeType: (row.mime_type as string) ?? 'image/jpeg',
            boundsX: (row.bounds_x as number) ?? null,
            boundsY: (row.bounds_y as number) ?? null,
            boundsW: (row.bounds_w as number) ?? null,
            boundsH: (row.bounds_h as number) ?? null,
            screenshotType: (row.screenshot_type as string) ?? null,
        };
    }

    private rowToFrameMeta(row: Record<string, unknown>): Omit<MaterialFrame, 'data'> {
        return {
            frameId: row.frame_id as string,
            materialId: row.material_id as string,
            windowId: row.window_id as number,
            timestamp: row.timestamp as number,
            width: row.width as number,
            height: row.height as number,
            title: (row.title as string) ?? null,
            application: (row.application as string) ?? null,
            bundleId: (row.bundle_id as string) ?? null,
            captureReason: (row.capture_reason as string) ?? 'UNKNOWN',
        };
    }

    private rowToTask(row: Record<string, unknown>): Task {
        return {
            taskId: row.task_id as string,
            label: row.label as string,
            description: (row.description as string) ?? null,
            application: (row.application as string) ?? null,
            confidence: (row.confidence as number) ?? null,
            status: row.status as string,
            approach: (row.approach as string) ?? null,
            parentTaskId: (row.parent_task_id as string) ?? null,
            level: (row.level as string) ?? 'leaf',
            firstSeen: row.first_seen as number,
            lastSeen: row.last_seen as number,
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
        };
    }

    private rowToTaskEvent(row: Record<string, unknown>): TaskEvent {
        return {
            id: row.id as number,
            eventId: (row.event_id as string) ?? null,
            taskId: row.task_id as string,
            parentTaskId: (row.parent_task_id as string) ?? null,
            status: row.status as string,
            label: (row.label as string) ?? null,
            description: (row.description as string) ?? null,
            application: (row.application as string) ?? null,
            confidence: (row.confidence as number) ?? null,
            approach: (row.approach as string) ?? null,
            level: (row.level as string) ?? null,
            timestamp: row.timestamp as number,
            requestTs: (row.request_ts as number) ?? null,
            responseTs: (row.response_ts as number) ?? null,
            createdAt: row.created_at as number,
        };
    }

    private rowToPerson(row: Record<string, unknown>): Person {
        return {
            personId: row.person_id as string,
            name: row.name as string,
            notes: (row.notes as string) ?? null,
            relationship: (row.relationship as string) ?? null,
            weight: (row.weight as number) ?? null,
            firstSeen: row.first_seen as number,
            lastSeen: row.last_seen as number,
            encounterCount: row.encounter_count as number,
        };
    }

    private rowToPersonEncounter(row: Record<string, unknown>): PersonEncounter {
        return {
            encounterId: row.encounter_id as string,
            personId: row.person_id as string,
            context: row.context as string,
            platform: (row.platform as string) ?? null,
            application: (row.application as string) ?? null,
            role: (row.role as string) ?? null,
            company: (row.company as string) ?? null,
            email: (row.email as string) ?? null,
            handle: (row.handle as string) ?? null,
            relationship: (row.relationship as string) ?? null,
            weight: (row.weight as number) ?? null,
            confidence: row.confidence as number,
            timestamp: row.timestamp as number,
            detectorEventId: (row.detector_event_id as string) ?? null,
        };
    }

    private rowToPersonProfile(row: Record<string, unknown>): PersonProfile {
        const splitDistinct = (v: unknown): string[] =>
            typeof v === 'string' && v ? v.split(',').filter(Boolean) : [];

        return {
            personId: row.person_id as string,
            name: row.name as string,
            notes: (row.notes as string) ?? null,
            relationship: (row.relationship as string) ?? null,
            weight: (row.weight as number) ?? null,
            firstSeen: row.first_seen as number,
            lastSeen: row.last_seen as number,
            encounterCount: row.encounter_count as number,
            currentRole: (row.current_role as string) ?? null,
            currentCompany: (row.current_company as string) ?? null,
            currentRelationship: (row.current_relationship as string) ?? null,
            allEmails: splitDistinct(row.all_emails),
            allHandles: splitDistinct(row.all_handles),
            allCompanies: splitDistinct(row.all_companies),
        };
    }
}
