import type { Module } from "../../contracts/module.js";
import { migrations } from "./migrations.js";

const mod: Module = {
  id: "deploy",
  milestone: "A",
  migrations,
  register() {},
};

export default mod;
