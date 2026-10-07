import type { ServiceRegistry, Services } from "../contracts/runtime.js";

export function createServiceRegistry(): ServiceRegistry {
  const provided = new Map<keyof Services, Services[keyof Services]>();
  return {
    provide(name, impl) {
      if (provided.has(name)) throw new Error(`Service "${name}" is already provided.`);
      provided.set(name, impl);
    },
    get(name) {
      const impl = provided.get(name);
      if (impl === undefined) throw new Error(`Service "${name}" has not been provided; is its module registered?`);
      return impl as Services[typeof name];
    },
    has: (name) => provided.has(name),
  };
}
