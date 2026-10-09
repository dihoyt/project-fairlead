import type { Module } from "../../contracts/module.js";
import { migrations } from "./migrations.js";

const postgres: Module = {
  id: "postgres",
  milestone: "B",
  migrations,
  register() {},
};

export default postgres;
