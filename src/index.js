import { loadConfig } from "./config/app.config.js";
import { initializeDatabase, closeDatabase } from "./core/teapot/sqlite/sqlite_db.js";
import { DownloadOrchestrator } from "./core/orchestrator/download.orchestrator.js";
import { banner, print } from "./shared/utils.js";
import {
  exportDownloadedItems,
  importDownloadedItems,
} from "./core/teapot/backup/downloaded_item.backup.js";
import "./modules/index.js";
import { WELCOME_MESSAGE, SUB_TITLE } from "./shared/messages.js";

class Kiroku {
  constructor() {
    this.config = null;
    this.orchestrator = null;
    this.shutdownController = new AbortController();
    this._registerShutdownHandlers();
  }

  _registerShutdownHandlers() {
    let shuttingDown = false;

    const handleSignal = (signal) => {
      if (shuttingDown) {
        print(`Received ${signal} again - forcing exit`, "error");
        process.exit(1);
      }
      shuttingDown = true;
      print(
        `Received ${signal} - finishing in-flight downloads, then stopping (press again to force quit)`,
        "warning",
      );
      this.shutdownController.abort();
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
  }

  async main() {
    banner(WELCOME_MESSAGE, SUB_TITLE);

    const command = process.argv[2] ?? "download";
    const flags = new Set(process.argv.slice(3));

    try {
      this.config = await loadConfig();
      print("Config loaded", "system");
    } catch (err) {
      print(`Failed to load config: ${err.message}`, "error");
      process.exit(1);
    }

    if (this._isBackupCommand(command)) {
      await this._runBackupCommand(command, flags);
      return;
    }

    if (this.config.database?.enabled) {
      await this._initDatabaseForDownload();
    }

    try {
      this.orchestrator = new DownloadOrchestrator(this.config, {
        signal: this.shutdownController.signal,
      });
      await this.orchestrator.run();
    } catch (err) {
      print(`Download orchestrator failed: ${err.message}`, "error");
    } finally {
      await this.disconnect();
    }
  }

  async disconnect() {
    if (this.config?.database?.enabled) {
      try {
        await closeDatabase();
      } catch (err) {
        print(`Error closing database: ${err.message}`, "error");
      }
    }
    print("Kiroku finished", "success");
  }

  async _runBackupCommand(command, flags) {
    const dbOk = await initializeDatabase();
    if (!dbOk) {
      print("Database init failed", "error");
      process.exitCode = 1;
      return;
    }

    this.config.database.enabled = true;

    try {
      if (command === "backup:export") {
        await exportDownloadedItems();
        return;
      }

      if (command === "backup:import") {
        await importDownloadedItems({
          clean: flags.has("--clean") || flags.has("-c"),
        });
      }
    } catch (err) {
      print(`Backup command failed: ${err.message}`, "error");
      process.exitCode = 1;
    } finally {
      await this.disconnect();
    }
  }

  async _initDatabaseForDownload() {
    try {
      const dbOk = await initializeDatabase();
      if (!dbOk) {
        print("Database init failed - continuing without DB", "warning");
        this.config.database.enabled = false;
      }
    } catch (err) {
      print(`Database error: ${err.message} - continuing without DB`, "warning");
      this.config.database.enabled = false;
    }
  }

  _isBackupCommand(command) {
    return command === "backup:export" || command === "backup:import";
  }
}

const kiroku = new Kiroku();
kiroku.main();
