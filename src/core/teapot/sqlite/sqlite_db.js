import { Sequelize } from "sequelize";
import { print, ensureDir } from "../../../shared/utils.js";
import { DATA_DIR, DEFAULT_DB_STORAGE } from "../../../config/app.config.js";

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: DEFAULT_DB_STORAGE,
  logging: false,
});

export async function initializeDatabase() {
  try {
    await ensureDir(DATA_DIR);

    // Dynamic import: registers models on `sequelize` before sync(), while
    // avoiding a top-level circular import (models/index.js imports `sequelize`
    // from this file).
    await import("../models/index.js");

    await sequelize.authenticate();
    print("Database connection established successfully", "system");

    await sequelize.sync();
    print("Database models synchronized", "system");

    return true;
  } catch (error) {
    print(`Unable to connect to the database: ${error.message}`, "error");
    console.log(error)
    return false;
  }
}

export async function closeDatabase() {
  try {
    await sequelize.close();
    print("Database connection closed", "system");
  } catch (error) {
    print(`Error closing database: ${error.message}`, "error");
  }
}

export default sequelize;