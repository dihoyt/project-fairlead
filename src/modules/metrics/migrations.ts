import type { Migration } from "../../contracts/runtime.js";

const ORG = "org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id)";

// Rollups keep count/sum/min/max rather than an average, so a sample is
// folded in with one upsert whenever it arrives and any bucket width built
// from them is an exact average of the samples beneath.
const rollupTable = (name: string) => `
  CREATE TABLE ${name} (
    series_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    count INTEGER NOT NULL,
    sum REAL NOT NULL,
    min REAL NOT NULL,
    max REAL NOT NULL,
    ${ORG},
    PRIMARY KEY (series_id, ts)
  ) WITHOUT ROWID;
`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "series, raw samples and 5-minute and hourly rollups",
    up: `
      CREATE TABLE metrics_series (
        id INTEGER PRIMARY KEY,
        series TEXT NOT NULL,
        labels TEXT NOT NULL,
        first_ts INTEGER NOT NULL,
        last_ts INTEGER NOT NULL,
        ${ORG},
        UNIQUE (org_id, series, labels)
      );
      CREATE TABLE metrics_raw (
        series_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        value REAL NOT NULL,
        ${ORG},
        PRIMARY KEY (series_id, ts)
      ) WITHOUT ROWID;
      ${rollupTable("metrics_5m")}
      ${rollupTable("metrics_1h")}
      CREATE INDEX metrics_raw_ts ON metrics_raw (ts);
      CREATE INDEX metrics_5m_ts ON metrics_5m (ts);
      CREATE INDEX metrics_1h_ts ON metrics_1h (ts);
    `,
  },
];
