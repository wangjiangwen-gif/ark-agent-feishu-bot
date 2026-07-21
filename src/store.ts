import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ConversationKey = {
  tenantKey: string;
  chatId: string;
  threadId: string;
  userOpenId: string;
};

export class GatewayStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_version TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  conversationKey(key: ConversationKey): string {
    return [key.tenantKey, key.chatId, key.threadId || "-", key.userOpenId || "-"].join(":");
  }

  getSession(key: ConversationKey): string | undefined {
    const row = this.db.prepare("SELECT session_id FROM conversations WHERE conversation_key = ?").get(this.conversationKey(key)) as { session_id: string } | undefined;
    return row?.session_id;
  }

  saveSession(key: ConversationKey, sessionId: string, agentId: string, agentVersion?: string): void {
    this.db.prepare(`
      INSERT INTO conversations (conversation_key, session_id, agent_id, agent_version, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        session_id = excluded.session_id,
        agent_id = excluded.agent_id,
        agent_version = excluded.agent_version,
        updated_at = excluded.updated_at
    `).run(this.conversationKey(key), sessionId, agentId, agentVersion || null, new Date().toISOString());
  }

  resetSession(key: ConversationKey): void {
    this.db.prepare("DELETE FROM conversations WHERE conversation_key = ?").run(this.conversationKey(key));
  }

  claimEvent(eventId: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO processed_events (event_id, status, updated_at) VALUES (?, 'processing', ?)").run(eventId, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  completeEvent(eventId: string, status: "completed" | "failed"): void {
    this.db.prepare("UPDATE processed_events SET status = ?, updated_at = ? WHERE event_id = ?").run(status, new Date().toISOString(), eventId);
  }

  close(): void {
    this.db.close();
  }
}
