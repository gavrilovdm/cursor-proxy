import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsageRecord, UsageStore } from "../ports.js";

/**
 * Usage as JSON lines in one file, ~150 bytes per call.
 *
 * Append-only, so a crash loses at most the line being written; a damaged
 * line is skipped on read instead of breaking the dashboard.
 */
export class FileUsageStore implements UsageStore {
  constructor(private readonly path: string) {}

  async append(record: UsageRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  async since(since: number): Promise<UsageRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: UsageRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as UsageRecord;
        if (record.at >= since) records.push(record);
      } catch {
        // A torn last line from a crash; the rest of the file is still good.
      }
    }
    return records;
  }
}

/** For tests and for running without a disk store. */
export class MemoryUsageStore implements UsageStore {
  readonly records: UsageRecord[] = [];
  async append(record: UsageRecord): Promise<void> {
    this.records.push(record);
  }
  async since(since: number): Promise<UsageRecord[]> {
    return this.records.filter((record) => record.at >= since);
  }
}
