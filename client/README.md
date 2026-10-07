# Client

Vite + React + Mantine. `CLAUDE.md` at the repo root has the rules; this covers working on the client alone.

```
npm --prefix client run dev                     # proxies /api and /auth to the server on :8080
VITE_MOCK_API=1 npm --prefix client run dev     # no server: every route answered from the contract's mocks
```

With the mock API, sign in as anything to be an admin. `user` is not an admin, `temp` must change its password, `totp` asks for a code (`000000`, or the recovery code `wrong`, is refused), and the password `wrong` is refused. The mock server is dropped from production builds.

`#/components` renders every shared component in `src/ui/` on mock data; it is in the sidebar only in development.

## What a client module uses

- `src/ui/index.ts`: the shared components (`Tile`, `StatusBadge`, `CheckList`, `TimeSeriesChart`, `Sparkline`), `useSeries`, and the typed API client: `apiRequest("GET /api/health/board")` and `useApi(key, { params, query }, { pollMs })`, keyed by the routes in `src/contracts/api.ts`.
- `useSession()` for the signed-in user (`me.admin` decides whether to show write actions; the server enforces them).
- `SeriesSourceProvider` with `mockSeriesFetcher` (`src/ui/mockSeriesFetcher.ts`) to draw charts on mock data.
