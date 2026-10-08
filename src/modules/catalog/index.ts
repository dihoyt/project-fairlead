import type { Module } from "../../contracts/module.js";
import { migrations } from "./migrations.js";

const mod: Module = {
  id: "catalog",
  milestone: "A",
  migrations,
  register() {},
};

export default mod;
