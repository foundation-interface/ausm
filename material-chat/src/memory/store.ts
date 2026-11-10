/**
 * Read-only memory store over the AUSM SQLite database.
 *
 * Owns:
 *   - FTS5 virtual table over material_processed (auto-created if missing)
 *   - Sync triggers (auto-created)
 *   - Composite-scored search query (BM25 + recency + dwell)
 *   - Recent / by-id lookup queries
 *
 * The base data (material_processed) is written by the existing
 * scripts/build_processed_table.py pipeline. This service only reads, plus
 * maintains the derived FTS5 index.
 */

import Database from 'better-sqlite3';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface SearchHit {
    material_id: string;
    title: string | null;
    bundle_id: string | null;
    last_seen: string | null;
    first_seen: string | null;
    frame_count: number;
    snippet: string;
    bm25: number;
    recency: number;
    dwell: number;
    score: number;
}

export interface RecentHit {
    material_id: string;
    title: string | null;
    bundle_id: string | null;
    first_seen: string | null;
    last_seen: string | null;
    frame_count: number;
}

export interface MaterialRecord {
    material_id: string;
    title: string | null;
    bundle_id: string | null;
    first_seen: string | null;
    last_seen: string | null;
    frame_count: number;
    cleaned_text: string | null;
    created_at: string;
}

export interface SearchOptions {
    topK?: number;
    bundle?: string | null;
    since?: string | null;       // ISO datetime
    recencyWeight?: number;      // default 0.5
    dwellWeight?: number;        // default 0.3
    recencyHalfLifeDays?: number;// default 30
}

export interface RecentOptions {
    topK?: number;
    since?: string | null;       // ISO datetime
    until?: string | null;       // ISO datetime
    bundle?: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Store
// ────────────────────────────────────────────────────────────────────────────

export class MemoryStore {
    private db: Database.Database;

    constructor(dbPath: string, opts: { readonly?: boolean } = {}) {
        // Read-only mode is safer (this service never writes material data)
        // but we still need write access to create/maintain the FTS5 index.
        // So we open read-write but only this service is responsible for the
        // FTS5 surface; the upstream pipeline writes material_processed.
        this.db = new Database(dbPath, { readonly: opts.readonly ?? false });
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('cache_size = -64000');  // 64MB
        this.ensureSchema();
    }

    close(): void {
        this.db.close();
    }

    // ── Schema setup ────────────────────────────────────────────────────────

    /**
     * Create the FTS5 virtual table and sync triggers if they don't exist.
     * Idempotent: safe to call on every startup.
     */
    private tableType(name: string): 'table' | 'view' | null {
        const row = this.db.prepare(
            `SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`
        ).get(name) as { type: string } | undefined;
        return (row?.type as 'table' | 'view') ?? null;
    }

    private ensureSchema(): void {
        // Current AUSM pin stores OCR on materials + material_ocr_results
        // (epoch-ms timestamps). Older DBs have a physical material_processed
        // table. Prefer a view over the live tables so search stays current.
        if (this.tableType('materials') && this.tableType('material_processed') !== 'table') {
            this.db.exec(`
                DROP VIEW IF EXISTS material_processed;
                CREATE VIEW material_processed AS
                SELECT
                    m.material_id AS material_id,
                    m.title AS title,
                    m.bundle_id AS bundle_id,
                    datetime(m.first_seen / 1000.0, 'unixepoch') AS first_seen,
                    datetime(m.last_seen / 1000.0, 'unixepoch') AS last_seen,
                    COALESCE(o.frame_count, 0) AS frame_count,
                    o.text AS cleaned_text,
                    datetime(m.first_seen / 1000.0, 'unixepoch') AS created_at
                FROM materials m
                LEFT JOIN material_ocr_results o ON o.material_id = m.material_id;
            `);
        }

        if (!this.tableType('material_processed') && !this.tableType('materials')) {
            console.error(
                '[material-chat] no materials / material_processed table yet — search will be empty until AUSM writes the DB',
            );
        }

        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS material_processed_fts USING fts5(
                material_id UNINDEXED,
                title,
                cleaned_text,
                bundle_id UNINDEXED,
                tokenize = 'trigram'
            );
        `);

        // Triggers on the live write tables. material_processed is often a VIEW
        // now, so we cannot attach triggers to it.
        if (this.tableType('material_ocr_results') === 'table') {
            this.db.exec(`
                CREATE TRIGGER IF NOT EXISTS ocr_fts_ai AFTER INSERT ON material_ocr_results
                BEGIN
                    DELETE FROM material_processed_fts WHERE material_id = new.material_id;
                    INSERT INTO material_processed_fts(material_id, title, cleaned_text, bundle_id)
                    SELECT new.material_id, COALESCE(m.title, ''), COALESCE(new.text, ''), COALESCE(m.bundle_id, '')
                    FROM materials m WHERE m.material_id = new.material_id;
                END;

                CREATE TRIGGER IF NOT EXISTS ocr_fts_au AFTER UPDATE ON material_ocr_results
                BEGIN
                    DELETE FROM material_processed_fts WHERE material_id = old.material_id;
                    INSERT INTO material_processed_fts(material_id, title, cleaned_text, bundle_id)
                    SELECT new.material_id, COALESCE(m.title, ''), COALESCE(new.text, ''), COALESCE(m.bundle_id, '')
                    FROM materials m WHERE m.material_id = new.material_id;
                END;

                CREATE TRIGGER IF NOT EXISTS ocr_fts_ad AFTER DELETE ON material_ocr_results
                BEGIN
                    DELETE FROM material_processed_fts WHERE material_id = old.material_id;
                END;
            `);
        } else if (this.tableType('material_processed') === 'table') {
            this.db.exec(`
                CREATE TRIGGER IF NOT EXISTS mp_fts_ai AFTER INSERT ON material_processed
                BEGIN
                    INSERT INTO material_processed_fts(material_id, title, cleaned_text, bundle_id)
                    VALUES (
                        new.material_id,
                        COALESCE(new.title, ''),
                        COALESCE(new.cleaned_text, ''),
                        COALESCE(new.bundle_id, '')
                    );
                END;

                CREATE TRIGGER IF NOT EXISTS mp_fts_au AFTER UPDATE ON material_processed
                BEGIN
                    DELETE FROM material_processed_fts WHERE material_id = old.material_id;
                    INSERT INTO material_processed_fts(material_id, title, cleaned_text, bundle_id)
                    VALUES (
                        new.material_id,
                        COALESCE(new.title, ''),
                        COALESCE(new.cleaned_text, ''),
                        COALESCE(new.bundle_id, '')
                    );
                END;

                CREATE TRIGGER IF NOT EXISTS mp_fts_ad AFTER DELETE ON material_processed
                BEGIN
                    DELETE FROM material_processed_fts WHERE material_id = old.material_id;
                END;
            `);
        }

        if (this.tableType('material_processed')) {
            const ftsCount = (this.db.prepare(
                `SELECT COUNT(*) AS c FROM material_processed_fts`
            ).get() as { c: number }).c;
            const srcCount = (this.db.prepare(
                `SELECT COUNT(*) AS c FROM material_processed WHERE cleaned_text IS NOT NULL`
            ).get() as { c: number }).c;

            if (ftsCount === 0 && srcCount > 0) {
                this.db.exec(`
                    INSERT INTO material_processed_fts(material_id, title, cleaned_text, bundle_id)
                    SELECT
                        material_id,
                        COALESCE(title, ''),
                        COALESCE(cleaned_text, ''),
                        COALESCE(bundle_id, '')
                    FROM material_processed
                    WHERE cleaned_text IS NOT NULL;
                `);
            }
        }
    }

    // ── Queries ─────────────────────────────────────────────────────────────

    search(query: string, opts: SearchOptions = {}): SearchHit[] {
        if (!this.tableType('material_processed')) return [];
        const topK = opts.topK ?? 10;
        const bundle = opts.bundle ?? null;
        const since = opts.since ?? null;
        const recencyWeight = opts.recencyWeight ?? 0.5;
        const dwellWeight = opts.dwellWeight ?? 0.3;
        const halfLife = opts.recencyHalfLifeDays ?? 30.0;

        const ftsQuery = escapeFTS(query);
        if (!ftsQuery) return [];

        // Pull a wider candidate set from FTS, then compute composite score in SQL.
        // Doing it in one statement keeps it fast (<50ms even at scale).
        const sql = `
            WITH ranked AS (
                SELECT
                    fts.material_id,
                    bm25(material_processed_fts) AS bm25_raw,
                    snippet(material_processed_fts, 2, '⟦', '⟧', '…', 32) AS snippet
                FROM material_processed_fts fts
                WHERE material_processed_fts MATCH ?
                ORDER BY bm25_raw
                LIMIT 50
            )
            SELECT
                m.material_id,
                m.title,
                m.bundle_id,
                m.first_seen,
                m.last_seen,
                m.frame_count,
                r.snippet,
                -r.bm25_raw                                                       AS bm25,
                CASE WHEN m.last_seen IS NULL THEN 0.0
                     ELSE exp(-(julianday('now') - julianday(m.last_seen)) / ?)
                END                                                               AS recency,
                CASE WHEN m.frame_count IS NULL THEN 0.0
                     ELSE log(1 + m.frame_count)
                END                                                               AS dwell,
                (-r.bm25_raw)
                  + ? * CASE WHEN m.last_seen IS NULL THEN 0.0
                             ELSE exp(-(julianday('now') - julianday(m.last_seen)) / ?)
                        END
                  + ? * CASE WHEN m.frame_count IS NULL THEN 0.0
                             ELSE log(1 + m.frame_count)
                        END                                                       AS score
            FROM ranked r
            JOIN material_processed m USING (material_id)
            WHERE (?  IS NULL OR m.bundle_id = ?)
              AND (?  IS NULL OR m.last_seen >= ?)
            ORDER BY score DESC
            LIMIT ?;
        `;

        const rows = this.db.prepare(sql).all(
            ftsQuery,
            halfLife,
            recencyWeight, halfLife,
            dwellWeight,
            bundle, bundle,
            since, since,
            topK,
        ) as SearchHit[];

        return rows;
    }

    recent(opts: RecentOptions = {}): RecentHit[] {
        if (!this.tableType('material_processed')) return [];
        const topK = opts.topK ?? 20;
        const since = opts.since ?? null;
        const until = opts.until ?? null;
        const bundle = opts.bundle ?? null;

        const sql = `
            SELECT material_id, title, bundle_id, first_seen, last_seen, frame_count
            FROM material_processed
            WHERE cleaned_text IS NOT NULL
              AND (?  IS NULL OR last_seen >= ?)
              AND (?  IS NULL OR last_seen <= ?)
              AND (?  IS NULL OR bundle_id = ?)
            ORDER BY last_seen DESC
            LIMIT ?
        `;

        return this.db.prepare(sql).all(
            since, since,
            until, until,
            bundle, bundle,
            topK,
        ) as RecentHit[];
    }

    getMaterial(id: string): MaterialRecord | null {
        if (!this.tableType('material_processed')) return null;
        const row = this.db.prepare(`
            SELECT material_id, title, bundle_id, first_seen, last_seen,
                   frame_count, cleaned_text, created_at
            FROM material_processed
            WHERE material_id = ?
        `).get(id) as MaterialRecord | undefined;
        return row ?? null;
    }

    stats(): { total: number; with_text: number; fts_indexed: number } {
        if (!this.tableType('material_processed')) {
            return { total: 0, with_text: 0, fts_indexed: 0 };
        }
        const total = (this.db.prepare(
            `SELECT COUNT(*) AS c FROM material_processed`
        ).get() as { c: number }).c;
        const withText = (this.db.prepare(
            `SELECT COUNT(*) AS c FROM material_processed WHERE cleaned_text IS NOT NULL`
        ).get() as { c: number }).c;
        const fts = (this.db.prepare(
            `SELECT COUNT(*) AS c FROM material_processed_fts`
        ).get() as { c: number }).c;
        return { total, with_text: withText, fts_indexed: fts };
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip FTS5 special characters and wrap remaining words so the user can
 * pass natural-language queries without worrying about syntax.
 *
 * Empty result → caller should return [] without hitting SQLite.
 */
function escapeFTS(query: string): string {
    const cleaned = query
        .replace(/["()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    // Quote each token so dashes and other glyphs become literal.
    return cleaned
        .split(' ')
        .filter((t) => t.length > 0)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(' ');
}
