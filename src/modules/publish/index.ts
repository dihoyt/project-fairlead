import type { Module } from "../../contracts/module.js";
import { migrations } from "./migrations.js";

const mod: Module = {
  id: "publish",
  milestone: "B",
  migrations,
  register() {},
};

export default mod;
