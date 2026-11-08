import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Ordered schema migrations; PRAGMA user_version records how many have been applied. */
const MIGRATIONS: string[] = [
  // 1: conversations, agent task queue, code memory
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    messages_json TEXT NOT NULL
  );
  CREATE INDEX conversations_updated ON conversations(updated_at DESC);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    role TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled','interrupted')),
    use_memory INTEGER NOT NULL DEFAULT 0,
    pipeline_id TEXT,
    pipeline_step INTEGER,
    session_id TEXT,
    checkpoint TEXT,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX tasks_workspace ON tasks(workspace, id);

  CREATE TABLE memory_files (
    workspace TEXT NOT NULL,
    path TEXT NOT NULL,
    hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    PRIMARY KEY (workspace, path)
  );

  CREATE TABLE memory_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL
  );
  CREATE INDEX memory_chunks_file ON memory_chunks(workspace, path);

  CREATE TABLE memory_meta (
    workspace TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  `,
  // 2: inference performance and the persistent network activity log
  `
  CREATE TABLE inference_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    tokens_per_second REAL NOT NULL,
    prompt_ms REAL NOT NULL,
    load_ms REAL NOT NULL,
    total_ms REAL NOT NULL
  );
  CREATE INDEX inference_metrics_model ON inference_metrics(model, id);

  CREATE TABLE network_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    source TEXT NOT NULL,
    method TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    allowed INTEGER NOT NULL,
    reason TEXT NOT NULL
  );
  `,
  // 3: agent jobs (a single task or a pipeline); jobs running in parallel edit their own git worktree
  `
  ALTER TABLE tasks ADD COLUMN job_id TEXT;
  CREATE TABLE agent_jobs (
    id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    path TEXT NOT NULL,
    base TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active','ready','empty','merged','discarded')),
    changes INTEGER,
    merge_checkpoint TEXT,
    conflicts TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace, id)
  );
  `,
  // 4: agent speed measured from llama-server counters, per task
  `
  ALTER TABLE inference_metrics ADD COLUMN task_id INTEGER;
  `,
  // 5: word index of the memory chunks (hybrid search: exact names and words next to the embeddings).
  // Rows share the chunk id; `words` holds the path and the code with identifiers split (resolveInWorkspace →
  // resolve in workspace). Chunks indexed before this migration get their rows from the backfill in MemoryService.
  `
  CREATE VIRTUAL TABLE memory_fts USING fts5(workspace UNINDEXED, words, tokenize='unicode61 remove_diacritics 2');
  `,
  // 6: launch profiles found by the autotuner (NSC stage 3), one per model, with the measurements behind them
  `
  CREATE TABLE model_profiles (
    model TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  `,
]

export function vecExtensionPath(appRoot: string, resourcesPath: string | null): string {
  const packaged = resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll') : null
  if (packaged && fs.existsSync(packaged)) return packaged
  return path.join(appRoot, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll')
}

/** Local SQLite database (WAL) with the sqlite-vec extension loaded. */
export class Database {
  readonly db: DatabaseSync

  constructor(file: string, vecExtension: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file, { allowExtension: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.db.loadExtension(vecExtension)
    this.migrate()
  }

  get version(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  }

  private migrate(): void {
    for (let v = this.version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}
