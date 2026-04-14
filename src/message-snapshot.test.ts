import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeGroupMessageSnapshot } from './message-snapshot.js';

let tmpRoot: string;
let storeDir: string;
let dataDir: string;

function seedSourceDb() {
  const src = new Database(path.join(storeDir, 'messages.db'));
  src.exec(`
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
  `);

  const insChat = src.prepare(
    'INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)',
  );
  insChat.run('tg:alpha:1', 'Alpha Chat', '2026-04-12T00:00:00Z', 'telegram', 0);
  insChat.run('tg:beta:2', 'Beta Chat', '2026-04-12T00:00:00Z', 'telegram', 0);

  const insMsg = src.prepare(
    'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // Alpha group: 3 rows
  insMsg.run('a-1', 'tg:alpha:1', 'u1', 'Kyle', 'alpha hello', '2026-04-12T01:00:00Z', 0, 0, null, null, null);
  insMsg.run('a-2', 'tg:alpha:1', 'bot', 'Alpha', 'alpha reply', '2026-04-12T01:00:01Z', 1, 1, 'a-1', 'alpha hello', 'Kyle');
  insMsg.run('a-3', 'tg:alpha:1', 'u1', 'Kyle', 'alpha bye', '2026-04-12T01:00:02Z', 0, 0, null, null, null);
  // Beta group: 2 rows (must NOT appear in alpha snapshot)
  insMsg.run('b-1', 'tg:beta:2', 'u1', 'Kyle', 'beta hi', '2026-04-12T02:00:00Z', 0, 0, null, null, null);
  insMsg.run('b-2', 'tg:beta:2', 'bot', 'Beta', 'beta yo', '2026-04-12T02:00:01Z', 1, 1, null, null, null);

  src.close();
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-snapshot-'));
  storeDir = path.join(tmpRoot, 'store');
  dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  seedSourceDb();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('writeGroupMessageSnapshot', () => {
  it('returns the directory (not the .db file) for directory-mount compatibility', () => {
    const result = writeGroupMessageSnapshot('alpha-folder', 'tg:alpha:1', {
      storeDir,
      dataDir,
    });
    expect(result).toBe(path.join(dataDir, 'sessions', 'alpha-folder', 'db'));
    expect(fs.statSync(result).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(result, 'messages.db'))).toBe(true);
  });

  it('includes only rows for the target chat_jid', () => {
    const dir = writeGroupMessageSnapshot('alpha-folder', 'tg:alpha:1', {
      storeDir,
      dataDir,
    });
    const snap = new Database(path.join(dir, 'messages.db'), { readonly: true });
    const jids = snap
      .prepare('SELECT DISTINCT chat_jid FROM messages')
      .all() as { chat_jid: string }[];
    expect(jids).toEqual([{ chat_jid: 'tg:alpha:1' }]);

    const count = (
      snap.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
    ).c;
    expect(count).toBe(3);
    snap.close();
  });

  it('excludes other groups entirely — no row leakage even without WHERE', () => {
    const dir = writeGroupMessageSnapshot('alpha-folder', 'tg:alpha:1', {
      storeDir,
      dataDir,
    });
    const snap = new Database(path.join(dir, 'messages.db'), { readonly: true });

    // Simulate an agent running a WHERE-less query: they still only see alpha
    const allMsgs = snap.prepare('SELECT chat_jid FROM messages').all() as {
      chat_jid: string;
    }[];
    expect(allMsgs.every((r) => r.chat_jid === 'tg:alpha:1')).toBe(true);

    const allChats = snap.prepare('SELECT jid FROM chats').all() as {
      jid: string;
    }[];
    expect(allChats).toEqual([{ jid: 'tg:alpha:1' }]);
    snap.close();
  });

  it('preserves full messages schema including reply_to_* columns', () => {
    const dir = writeGroupMessageSnapshot('alpha-folder', 'tg:alpha:1', {
      storeDir,
      dataDir,
    });
    const snap = new Database(path.join(dir, 'messages.db'), { readonly: true });
    const row = snap
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get('a-2') as Record<string, unknown>;
    expect(row.reply_to_message_id).toBe('a-1');
    expect(row.reply_to_message_content).toBe('alpha hello');
    expect(row.reply_to_sender_name).toBe('Kyle');
    expect(row.is_from_me).toBe(1);
    expect(row.is_bot_message).toBe(1);
    snap.close();
  });

  it('rewrites the snapshot cleanly when called again', () => {
    // First call seeds snapshot
    writeGroupMessageSnapshot('alpha-folder', 'tg:alpha:1', {
      storeDir,
      dataDir,
    });

    // Delete one row from the source between calls
    const src = new Database(path.join(storeDir, 'messages.db'));
    src.prepare('DELETE FROM messages WHERE id = ?').run('a-3');
    src.close();

    // Second call should reflect the deletion
    const dir = writeGroupMessageSnapshot('alpha-folder', 'tg:alpha:1', {
      storeDir,
      dataDir,
    });
    const snap = new Database(path.join(dir, 'messages.db'), { readonly: true });
    const ids = snap
      .prepare('SELECT id FROM messages ORDER BY id')
      .all() as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(['a-1', 'a-2']);
    snap.close();
  });

  it('produces an empty but valid snapshot for a chat_jid with no messages', () => {
    const dir = writeGroupMessageSnapshot('ghost-folder', 'tg:ghost:999', {
      storeDir,
      dataDir,
    });
    const snap = new Database(path.join(dir, 'messages.db'), { readonly: true });
    const count = (
      snap.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
    ).c;
    expect(count).toBe(0);
    // Schema should still exist so downstream queries don't error
    const tables = snap
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(['chats', 'messages']);
    snap.close();
  });
});
