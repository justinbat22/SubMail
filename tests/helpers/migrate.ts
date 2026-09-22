import initialMigrationSql from "../../migrations/0001_initial.sql?raw";
import rateLimitsMigrationSql from "../../migrations/0002_rate_limits.sql?raw";
import mailboxLimitMigrationSql from "../../migrations/0003_mailbox_message_limit.sql?raw";
import messageIdempotencyMigrationSql from "../../migrations/0004_message_idempotency.sql?raw";

/**
 * Splits a migration file's SQL into individual statements.
 *
 * This is NOT a general-purpose SQL parser — it's just smart enough for
 * *our own* migration files. A naive `sql.split(";")` breaks as soon as any
 * statement contains an internal semicolon, which a trigger body always
 * does (`BEGIN ... ; ... END;`). This tracks BEGIN/END nesting depth and
 * only treats a `;` as a statement terminator when depth is 0.
 *
 * Full-line `--` comments are stripped first, since a comment can itself
 * contain a semicolon (several of ours do) — splitting before stripping
 * comments would otherwise chop a comment into a bogus "statement".
 */
export function splitSqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .map((line) => (line.trim().startsWith("--") ? "" : line))
    .join("\n");

  const statements: string[] = [];
  let current = "";
  let depth = 0;
  const upper = withoutComments.toUpperCase();

  let i = 0;
  while (i < withoutComments.length) {
    if (matchesWordAt(upper, i, "BEGIN")) {
      depth++;
      current += withoutComments.slice(i, i + 5);
      i += 5;
      continue;
    }
    if (matchesWordAt(upper, i, "END")) {
      depth = Math.max(0, depth - 1);
      current += withoutComments.slice(i, i + 3);
      i += 3;
      continue;
    }
    const ch = withoutComments[i] as string;
    if (ch === ";" && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);

  return statements;
}

function matchesWordAt(upperText: string, index: number, word: string): boolean {
  if (upperText.slice(index, index + word.length) !== word) return false;
  const before = index === 0 ? " " : (upperText[index - 1] as string);
  const after = upperText[index + word.length] ?? " ";
  const isWordChar = (c: string) => /[A-Z0-9_]/.test(c);
  return !isWordChar(before) && !isWordChar(after);
}

export async function applyMigrationSql(db: D1Database, sql: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    await db.prepare(statement).run();
  }
}

/** Applies every migration file, in order, matching what a real deployment runs. */
export async function applyAllMigrations(db: D1Database): Promise<void> {
  await applyMigrationSql(db, initialMigrationSql);
  await applyMigrationSql(db, rateLimitsMigrationSql);
  await applyMigrationSql(db, mailboxLimitMigrationSql);
  await applyMigrationSql(db, messageIdempotencyMigrationSql);
}

/** Resets all tables to empty between tests, without needing to drop/recreate the schema. */
export async function resetAllTables(db: D1Database): Promise<void> {
  await db.exec("DELETE FROM attachments;");
  await db.exec("DELETE FROM messages;");
  await db.exec("DELETE FROM mailboxes;");
  await db.exec("DELETE FROM rate_limits;");
  // mailbox_limits is a single global config row, not per-test data — reset
  // it to the migration's seeded default so a test that changes it (e.g. to
  // exercise the message-cap trigger with a small number) can't leak that
  // change into a later test in the same file.
  await db.prepare("UPDATE mailbox_limits SET value = 200 WHERE key = 'max_messages_per_mailbox'").run();
}
