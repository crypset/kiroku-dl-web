import { DataTypes } from "sequelize";
import sequelize from "../sqlite/sqlite_db.js";

export const DownloadedItem = sequelize.define(
  "DownloadedItem",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    searchName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    itemId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    title: DataTypes.STRING,
    url: DataTypes.STRING,
    filePath: DataTypes.STRING,
    downloadedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "downloaded_items",
    indexes: [{ unique: true, fields: ["searchName", "itemId"] }],
  },
);

export default { DownloadedItem };
