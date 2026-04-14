/**
 * Per-group filtered snapshot of messages.db.
 *
 * Non-main containers do not get the project root mounted, so they cannot
 * read the full messages.db. Before spawning a non-main container, the host
 * calls writeGroupMessageSnapshot() to produce a chat_jid-scoped subset
 * SQLite file that is mounted read-only at /workspace/project/store/.
 *
 * Isolation is physical: rows for other chat_jids are never written into the
 * snapshot, so an agent cannot see cross-group conversations even by dropping
 * the WHERE clause.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';

export interface SnapshotOptions {
  storeDir?: string;
  dataDir?: string;
}

/**
 * Build a chat_jid-scoped subset of messages.db for one group.
 *
 * Returns the host path of the snapshot *directory* (not the .db file).
 * The directory is what gets bind-mounted into the container — file mounts
 * are unreliable under Colima/Docker Desktop on macOS.
 */
export function writeGroupMessageSnapshot(
  groupFolder: string,
  chatJid: string,
  opts: SnapshotOptions = {},
): string {
  const storeDir = opts.storeDir ?? STORE_DIR;
  const dataDir = opts.dataDir ?? DATA_DIR;

  const snapshotDir = path.join(dataDir, 'sessions', groupFolder, 'db');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, 'messages.db');

  // Fresh rebuild each spawn. Small volume (usually < 1MB) and avoids any
  // chance of stale rows leaking from a previous run.
  if (fs.existsSync(snapshotPath)) fs.rmSync(snapshotPath);

  const srcPath = path.join(storeDir, 'messages.db');
  const src = new Database(srcPath, { readonly: true });
  const dst = new Database(snapshotPath);

  try {
    dst.exec(`
      CREATE TABLE chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT,
        channel TEXT,
        is_group INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        is_bot_message INTEGER DEFAULT 0,
        reply_to_message_id TEXT,
        reply_to_message_content TEXT,
        reply_to_sender_name TEXT,
        PRIMARY KEY (id, chat_jid)
      );
      CREATE INDEX idx_timestamp ON messages(timestamp);
    `);

    const chat = src
      .prepare(
        'SELECT jid, name, last_message_time, channel, is_group FROM chats WHERE jid = ?',
      )
      .get(chatJid) as Record<string, unknown> | undefined;

    const msgs = src
      .prepare(
        'SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name FROM messages WHERE chat_jid = ?',
      )
      .all(chatJid) as Record<string, unknown>[];

    const insChat = dst.prepare(
      'INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (@jid, @name, @last_message_time, @channel, @is_group)',
    );
    const insMsg = dst.prepare(
      'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (@id, @chat_jid, @sender, @sender_name, @content, @timestamp, @is_from_me, @is_bot_message, @reply_to_message_id, @reply_to_message_content, @reply_to_sender_name)',
    );

    const tx = dst.transaction(() => {
      if (chat) insChat.run(chat);
      for (const m of msgs) insMsg.run(m);
    });
    tx();

    logger.debug(
      { groupFolder, chatJid, messageCount: msgs.length },
      'Wrote group message snapshot',
    );
  } finally {
    src.close();
    dst.close();
  }

  return snapshotDir;
}
