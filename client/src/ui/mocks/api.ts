// Mock responses for every API route, the same objects the server-side
// tests use, plus a fetch stand-in for building a page before its API lands.
import { apiMocks } from "@contracts/mocks/api";
import type { ApiMocks, RouteKey } from "@contracts/api";

export { apiMocks };
export type { ApiMocks, RouteKey };

export function mockResponse<K extends RouteKey>(key: K): ApiMocks[K] {
  return structuredClone(apiMocks[key]);
}

// Resolves after `delayMs` with the route's mock, so loading states show.
export function mockFetch<K extends RouteKey>(key: K, delayMs = 150): Promise<ApiMocks[K]> {
  return new Promise((resolve) => setTimeout(() => resolve(mockResponse(key)), delayMs));
}
