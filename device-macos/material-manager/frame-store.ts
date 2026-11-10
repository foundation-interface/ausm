/**
 * Frame Store — SQLite-backed persistent storage for material frames.
 *
 * Uses better-sqlite3 for synchronous, high-performance access.
 * Frames (JPEG BLOBs) and material metadata are stored in a single
 * database file, replacing the previous in-memory frame arrays.
 *
 * Schema:
 *   materials — one row per material (title/tab within a window)
 *   frames    — one row per curated frame, with JPEG blob
 *
 * Privacy: frames are screenshots of user windows.  When `dbPath` is a file,
 * its parent directory is created with mode 0700 and the database file is
 * created/chmod'ed to 0600 (SQLite gives the -wal/-shm side files the same
 * mode as the main file).  Retention is bounded by `maxFramesPerMaterial`,
 * `maxTotalFrames` and (optionally) `maxFrameAgeMs`.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { Material, MaterialFrame } from './types';

// ── Configuration ─────────────────────────────────────────────────────────

export interface FrameStoreConfig {
    /** Path to the SQLite database file. Default: ':memory:' */
    dbPath?: string;
    /** Max frames to retain per material before oldest are evicted. Default: 200 */
    maxFramesPerMaterial?: number;
    /** Enable WAL mode for better concurrent performance. Default: true */
    walMode?: boolean;
    /**
     * Global cap on stored frames across all materials; the oldest frames
     * are evicted first.  0 disables the cap.  Default: 5000
     */
    maxTotalFrames?: number;
    /**
     * Frames older than this many ms are deleted.  0 disables age-based
     * retention.  Default: 0
     */
    maxFrameAgeMs?: number;
}

const DEFAULTS: Required<FrameStoreConfig> = {
    dbPath: ':memory:',
    maxFramesPerMaterial: 200,
    walMode: true,
    maxTotalFrames: 5000,
    maxFrameAgeMs: 0,
};

/** Run the global (total / age) retention pass every N inserted frames. */
const GLOBAL_RETENTION_EVERY = 25;

/** True if `dbPath` names an on-disk file (not ':memory:' / '' / a URI). */
function isFileDbPath(dbPath: string): boolean {
    return dbPath !== '' && dbPath !== ':memory:' && !dbPath.startsWith('file:');
}

/**
 * Create the database file (and its parent directory) with owner-only
 * permissions before SQLite opens it.  Best-effort: failures are left for
 * SQLite to report when it opens the file.
 */
function prepareDbFile(dbPath: string): void {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
        fs.closeSync(fs.openSync(dbPath, 'a', 0o600));
        fs.chmodSync(dbPath, 0o600);
    } catch {
        // e.g. not the owner — leave existing permissions alone
    }
}

// ── Frame Store ───────────────────────────────────────────────────────────

export class FrameStore {
    private db: Database.Database;
    private config: Required<FrameStoreConfig>;

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
    private stmtGetFrameCountByWindow!: Database.Statement;
    private stmtGetTotalFrameCount!: Database.Statement;
    private stmtDeleteOldestFrames!: Database.Statement;
    private stmtDeleteFramesOlderThan!: Database.Statement;
    private insertsSinceRetention = 0;

    constructor(config: FrameStoreConfig = {}) {
        this.config = { ...DEFAULTS, ...config };
        if (isFileDbPath(this.config.dbPath)) {
            prepareDbFile(this.config.dbPath);
        }
        this.db = new Database(this.config.dbPath);

        if (this.config.walMode) {
            this.db.pragma('journal_mode = WAL');
        }
        // Performance tuning
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -64000'); // 64MB cache

        this.createTables();
        this.migrateMaterialsTable();
        this.migrateFramesTable();
        this.prepareStatements();
        this.enforceGlobalRetention();
    }

    /** Add the capture_reason column to frames tables created by older versions. */
    private migrateFramesTable(): void {
        const info = this.db.pragma('table_info(frames)') as { name: string }[];
        if (!info.some((c) => c.name === 'capture_reason')) {
            this.db.exec(`ALTER TABLE frames ADD COLUMN capture_reason TEXT`);
        }
    }

    /** Add newer columns to existing databases (each checked independently). */
    private migrateMaterialsTable(): void {
        const info = this.db.pragma('table_info(materials)') as { name: string }[];
        const have = new Set(info.map((c) => c.name));
        const added: Array<[string, string]> = [
            ['material_type', 'TEXT'],
            ['material_type_confidence', 'REAL'],
            ['app_metadata', 'TEXT'],
        ];
        for (const [name, type] of added) {
            if (!have.has(name)) this.db.exec(`ALTER TABLE materials ADD COLUMN ${name} ${type}`);
        }
    }

    // ── Schema ────────────────────────────────────────────────────────────

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
                material_type_confidence REAL,
                app_metadata  TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_materials_window
                ON materials(window_id);

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

            CREATE INDEX IF NOT EXISTS idx_frames_material
                ON frames(material_id, timestamp);

            CREATE INDEX IF NOT EXISTS idx_frames_window
                ON frames(window_id, timestamp);

            CREATE INDEX IF NOT EXISTS idx_frames_timestamp
                ON frames(timestamp);
        `);
    }

    private prepareStatements(): void {
        this.stmtInsertMaterial = this.db.prepare(`
            INSERT INTO materials
                (material_id, title, window_id, application, bundle_id,
                 document_path, last_frame_hash, first_seen, last_seen,
                 material_type, material_type_confidence, app_metadata)
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
                app_metadata = COALESCE(excluded.app_metadata, app_metadata)
        `);

        this.stmtUpdateMaterial = this.db.prepare(`
            UPDATE materials SET
                last_frame_hash = ?,
                last_seen = MAX(?, last_seen),
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
        `);

        this.stmtGetFrameCountByWindow = this.db.prepare(
            'SELECT COUNT(*) as count FROM frames WHERE window_id = ?',
        );

        this.stmtGetTotalFrameCount = this.db.prepare('SELECT COUNT(*) as count FROM frames');

        this.stmtDeleteOldestFrames = this.db.prepare(`
            DELETE FROM frames
            WHERE frame_id IN (
                SELECT frame_id FROM frames
                ORDER BY timestamp ASC
                LIMIT ?
            )
        `);

        this.stmtDeleteFramesOlderThan = this.db.prepare('DELETE FROM frames WHERE timestamp < ?');
    }

    // ── Material operations ───────────────────────────────────────────────

    /** Persist a material record (upsert). */
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

    /** Update a material's type classification. */
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

    /** Update a material's mutable fields (hash, lastSeen, documentPath). */
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

    /** Load a material by ID, or null if not found. */
    getMaterial(materialId: string): Material | null {
        const row = this.stmtGetMaterial.get(materialId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return this.rowToMaterial(row);
    }

    /** Load all materials from the database. */
    getAllMaterials(): Material[] {
        const rows = this.stmtGetAllMaterials.all() as Record<string, unknown>[];
        return rows.map((r) => this.rowToMaterial(r));
    }

    // ── Frame operations ──────────────────────────────────────────────────

    /**
     * Store a frame and evict old frames if over the per-material budget.
     * Returns the number of frames evicted.
     */
    addFrame(frame: MaterialFrame, hash: string): number {
        const evicted = this.db.transaction(() => {
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
                frame.captureReason ?? null,
            );

            // Update material metadata
            this.stmtUpdateMaterial.run(
                hash,
                frame.timestamp,
                null, // don't change documentPath
                frame.materialId,
            );

            // Evict oldest frames if over the per-material budget
            return this.evictOldFrames(frame.materialId);
        })();

        if (++this.insertsSinceRetention >= GLOBAL_RETENTION_EVERY) {
            return evicted + this.enforceGlobalRetention();
        }
        return evicted;
    }

    /** Get all frames for a material (with BLOB data). */
    getFrames(materialId: string): MaterialFrame[] {
        const rows = this.stmtGetFrames.all(materialId) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrame(r));
    }

    /** Get frame metadata only (no BLOB data) for a material. */
    getFramesMeta(materialId: string): Omit<MaterialFrame, 'data'>[] {
        const rows = this.stmtGetFramesMeta.all(materialId) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrameMeta(r));
    }

    /** Get all frames for a window (across all materials, with BLOB data). */
    getFramesByWindow(windowId: number): MaterialFrame[] {
        const rows = this.stmtGetFramesByWindow.all(windowId) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrame(r));
    }

    /** Get frame metadata for a window (no BLOB data). */
    getFramesByWindowMeta(windowId: number): Omit<MaterialFrame, 'data'>[] {
        const rows = this.stmtGetFramesByWindowMeta.all(windowId) as Record<string, unknown>[];
        return rows.map((r) => this.rowToFrameMeta(r));
    }

    /** Get the most recent frame for a material. */
    getLatestFrame(materialId: string): MaterialFrame | null {
        const row = this.stmtGetLatestFrame.get(materialId) as Record<string, unknown> | undefined;
        return row ? this.rowToFrame(row) : null;
    }

    /** Get a specific frame by ID. */
    getFrameById(frameId: string): MaterialFrame | null {
        const row = this.stmtGetFrameById.get(frameId) as Record<string, unknown> | undefined;
        return row ? this.rowToFrame(row) : null;
    }

    /** Get the frame count for a material. */
    getFrameCount(materialId: string): number {
        const row = this.stmtGetFrameCount.get(materialId) as { count: number };
        return row.count;
    }

    /** Get total frame count for a window (across all materials). */
    getFrameCountByWindow(windowId: number): number {
        const row = this.stmtGetFrameCountByWindow.get(windowId) as { count: number };
        return row.count;
    }

    // ── Eviction ──────────────────────────────────────────────────────────

    /**
     * Evict oldest frames for a material if over budget.
     * Returns the number of frames deleted.
     */
    evictOldFrames(materialId: string): number {
        const count = this.getFrameCount(materialId);
        const excess = count - this.config.maxFramesPerMaterial;
        if (excess <= 0) return 0;

        const result = this.stmtDeleteOldFrames.run(materialId, excess);
        return result.changes;
    }

    /**
     * Delete all frames older than the given timestamp.
     * Returns the number of frames deleted.
     */
    deleteFramesOlderThan(timestampMs: number): number {
        const result = this.stmtDeleteFramesOlderThan.run(timestampMs);
        return result.changes;
    }

    /**
     * Apply the global retention limits (`maxFrameAgeMs`, `maxTotalFrames`).
     * Runs automatically on open and every few inserts; may be called
     * manually.  Returns the number of frames deleted.
     */
    enforceGlobalRetention(): number {
        this.insertsSinceRetention = 0;
        let deleted = 0;
        if (this.config.maxFrameAgeMs > 0) {
            deleted += this.deleteFramesOlderThan(Date.now() - this.config.maxFrameAgeMs);
        }
        if (this.config.maxTotalFrames > 0) {
            const total = (this.stmtGetTotalFrameCount.get() as { count: number }).count;
            const excess = total - this.config.maxTotalFrames;
            if (excess > 0) {
                deleted += this.stmtDeleteOldestFrames.run(excess).changes;
            }
        }
        return deleted;
    }

    // ── Stats ─────────────────────────────────────────────────────────────

    /** Get aggregate stats for the store. */
    getStats(): { materialCount: number; frameCount: number; dbSizeBytes: number } {
        const matRow = this.db
            .prepare('SELECT COUNT(*) as count FROM materials')
            .get() as { count: number };
        const frmRow = this.db
            .prepare('SELECT COUNT(*) as count FROM frames')
            .get() as { count: number };

        // page_count * page_size gives the database file size
        const pageCount = this.db.pragma('page_count', { simple: true }) as number;
        const pageSize = this.db.pragma('page_size', { simple: true }) as number;

        return {
            materialCount: matRow.count,
            frameCount: frmRow.count,
            dbSizeBytes: pageCount * pageSize,
        };
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /** Whether the database connection is open. */
    get isOpen(): boolean {
        return this.db.open;
    }

    /** Close the database connection (idempotent). */
    close(): void {
        if (this.db.open) this.db.close();
    }

    // ── Row mappers ───────────────────────────────────────────────────────

    private rowToMaterial(row: Record<string, unknown>): Material {
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
            appMetadata: parseAppMetadata(row.app_metadata),
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
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Safely deserialize the JSON-encoded app_metadata column. */
function parseAppMetadata(value: unknown): Record<string, string | null> | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, string | null>;
        }
    } catch {
        // Corrupt JSON — treat as missing rather than crashing the row mapper.
    }
    return null;
}
