import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { DownloadedItem } from "../models/index.js";
import { print, saveToJson, ensureDir } from "../../../shared/utils.js";

const BACKUP_PATH = resolve(process.cwd(), "data", "backups", "downloaded_items.json");

/**
 * Dumps the downloaded_items table to a JSON file.
 * @param {string} [filePath]
 * @returns {Promise<number>} number of records exported
 */
export async function exportDownloadedItems(filePath = BACKUP_PATH) {
  const rows = await DownloadedItem.findAll({ raw: true });

  await ensureDir(dirname(filePath));
  await saveToJson(filePath, rows);

  print(`Exported ${rows.length} record(s) to ${filePath}`, "success");
  return rows.length;
}

/**
 * Restores the downloaded_items table from a JSON backup.
 * Existing (searchName, itemId) pairs are left untouched unless `clean` is set.
 * @param {{ filePath?: string, clean?: boolean }} [options]
 * @returns {Promise<number>} number of records imported
 */
export async function importDownloadedItems({ filePath = BACKUP_PATH, clean = false } = {}) {
  let raw;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    print(`Backup file not found: ${filePath}`, "error");
    return 0;
  }

  const records = JSON.parse(raw);

  if (clean) {
    await DownloadedItem.destroy({ where: {}, truncate: true });
  }

  let imported = 0;
  for (const record of records) {
    const { id, ...rest } = record;
    await DownloadedItem.findOrCreate({
      where: { searchName: rest.searchName, itemId: rest.itemId },
      defaults: rest,
    });
    imported++;
  }

  print(`Imported ${imported} record(s) from ${filePath}`, "success");
  return imported;
}
